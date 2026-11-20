//! WebDAV specifics the generic storage layer can't express: where and how to upload.

/// What a streaming upload needs: the server URL (ending in `/`), the sign-in, and the HTTP
/// client (the same certificate trust as the account's operator).
pub struct DavTarget {
    pub base: String,
    pub username: String,
    pub password: String,
    pub client: reqwest013::Client,
}

impl std::fmt::Debug for DavTarget {
    // Never the password.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DavTarget")
            .field("base", &self.base)
            .field("username", &self.username)
            .finish_non_exhaustive()
    }
}

/// One path segment for a URL: unreserved characters as they are, everything else (spaces, `#`,
/// `+`, `?`, non-ASCII) percent-encoded.
fn encode_segment(segment: &str) -> String {
    segment
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

impl DavTarget {
    /// The URL of a UI path (`/a/b.txt`) on this server; folders end in `/`.
    pub fn url_for(&self, ui_path: &str, dir: bool) -> String {
        let key: Vec<String> = ui_path
            .split('/')
            .filter(|s| !s.is_empty())
            .map(encode_segment)
            .collect();
        let mut url = format!("{}{}", self.base, key.join("/"));
        if dir && !key.is_empty() {
            url.push('/');
        }
        url
    }
}

/// What a WebDAV upload's reply means for the job (`None`: it landed).
pub fn status_error(status: u16) -> Option<crate::transfers::model::JobError> {
    use crate::transfers::model::{JobError, DEST_CHANGED};
    let operation = |why: &str| Some(JobError::Operation(why.to_string()));
    match status {
        200 | 201 | 204 => None,
        401 => operation("upload: the server refused the username or password"),
        403 => operation("upload: the server refused to write there"),
        404 | 409 => operation("upload: the folder doesn't exist on the server"),
        405 => operation("upload: the server doesn't allow uploads there"),
        412 => Some(JobError::Operation(DEST_CHANGED.into())),
        code => Some(JobError::Connection(format!(
            "upload: the server answered {code}"
        ))),
    }
}

fn request_error(e: reqwest013::Error) -> crate::transfers::model::JobError {
    use crate::transfers::model::JobError;
    if crate::storage::tls::is_cert_error(&e) {
        return JobError::Operation(crate::storage::tls::CERT_UNTRUSTED.into());
    }
    JobError::Connection(format!("upload: {e}"))
}

type Chunk = Result<Vec<u8>, std::io::Error>;

/// One streaming `PUT`: the body is fed chunk by chunk, so memory stays constant at any size.
/// Dropping it unfinished aborts the request.
pub struct DavUpload {
    tx: Option<tokio::sync::mpsc::Sender<Chunk>>,
    reply: Option<tokio::task::JoinHandle<Result<u16, reqwest013::Error>>>,
    stopped: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// How long the server may stop reading (or answering) before the upload fails.
    stall: std::time::Duration,
}

const STALLED: &str = "upload: the server stopped reading";

impl DavTarget {
    pub fn start_put(&self, ui_path: &str, opts: crate::transfers::io::WriteOpts) -> DavUpload {
        self.start_put_stalling(ui_path, opts, super::accounts::IO_TIMEOUT)
    }

    pub fn start_put_stalling(
        &self,
        ui_path: &str,
        opts: crate::transfers::io::WriteOpts,
        stall: std::time::Duration,
    ) -> DavUpload {
        use std::sync::atomic::Ordering;
        let (tx, rx) = tokio::sync::mpsc::channel::<Chunk>(4);
        let stopped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = stopped.clone();
        let body = futures::stream::unfold((rx, flag), |(mut rx, flag)| async move {
            match rx.recv().await {
                Some(chunk) => Some((chunk, (rx, flag))),
                // A stopped body must not end like a finished one, or the server keeps the cut file.
                None if flag.load(Ordering::SeqCst) => {
                    Some((Err(std::io::Error::other("upload stopped")), (rx, flag)))
                }
                None => None,
            }
        });
        let mut req = self
            .client
            .put(self.url_for(ui_path, false))
            .basic_auth(&self.username, Some(&self.password))
            .body(reqwest013::Body::wrap_stream(body));
        // Nextcloud and ownCloud keep the file's own time; other servers ignore it.
        if opts.mtime > 0 {
            req = req.header("X-OC-Mtime", opts.mtime.to_string());
        }
        if opts.if_not_exists {
            req = req.header("If-None-Match", "*");
        }
        if let Some(len) = opts.len {
            req = req.header(reqwest013::header::CONTENT_LENGTH, len);
        }
        let reply = tokio::spawn(async move { req.send().await.map(|r| r.status().as_u16()) });
        DavUpload {
            tx: Some(tx),
            reply: Some(reply),
            stopped,
            stall,
        }
    }
}

impl DavUpload {
    /// The request's outcome, once it ended (early, on a refusal or a dropped connection).
    async fn outcome(&mut self) -> Result<(), crate::transfers::model::JobError> {
        use crate::transfers::model::JobError;
        let Some(reply) = self.reply.take() else {
            return Err(JobError::Stopped);
        };
        match reply.await {
            Ok(Ok(status)) => status_error(status).map_or(Ok(()), Err),
            Ok(Err(e)) => Err(request_error(e)),
            Err(_) => Err(JobError::Stopped),
        }
    }

    pub async fn send(&mut self, chunk: Vec<u8>) -> Result<(), crate::transfers::model::JobError> {
        let Some(tx) = self.tx.as_ref() else {
            return Err(crate::transfers::model::JobError::Stopped);
        };
        let Ok(sent) = tokio::time::timeout(self.stall, tx.send(Ok(chunk))).await else {
            self.abort();
            return Err(crate::transfers::model::JobError::Connection(
                STALLED.into(),
            ));
        };
        if sent.is_err() {
            // The server ended the request: report why.
            self.tx = None;
            return match self.outcome().await {
                Ok(()) => Err(crate::transfers::model::JobError::Connection(
                    "upload: the server closed the connection".into(),
                )),
                Err(e) => Err(e),
            };
        }
        Ok(())
    }

    /// Ends the body and waits for the server's answer.
    pub async fn finish(&mut self) -> Result<(), crate::transfers::model::JobError> {
        self.tx = None;
        let stall = self.stall;
        match tokio::time::timeout(stall, self.outcome()).await {
            Ok(done) => done,
            Err(_) => {
                self.abort();
                Err(crate::transfers::model::JobError::Connection(
                    STALLED.into(),
                ))
            }
        }
    }

    /// Stops the request; the server discards (or replaces later) what it got.
    pub fn abort(&mut self) {
        // Set before the sender goes, so the body ends in an error rather than cleanly.
        self.stopped
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.tx = None;
        if let Some(reply) = self.reply.take() {
            reply.abort();
        }
    }
}

impl Drop for DavUpload {
    fn drop(&mut self) {
        self.abort();
    }
}

/// Moves a whole folder in one WebDAV `MOVE`, never over an existing one.
pub async fn move_dir(t: &DavTarget, from: &str, to: &str) -> Result<(), String> {
    let method = reqwest013::Method::from_bytes(b"MOVE").map_err(|e| e.to_string())?;
    let res = t
        .client
        .request(method, t.url_for(from, true))
        .basic_auth(&t.username, Some(&t.password))
        .header("Destination", t.url_for(to, true))
        .header("Overwrite", "F")
        .send()
        .await
        .map_err(|e| format!("Couldn't move {from}: {e}"))?;
    match res.status().as_u16() {
        200 | 201 | 204 => Ok(()),
        412 => Err(format!("{to} already exists. Nothing was moved.")),
        403 => Err(format!("The server refused to move {from}")),
        code => Err(format!("Couldn't move {from}: the server answered {code}")),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// One recorded request: request line, lower-cased headers, body length.
    #[derive(Debug, Default, Clone)]
    pub(crate) struct Seen {
        pub line: String,
        pub headers: Vec<(String, String)>,
        pub body_len: usize,
        /// The body ended properly (its full length, or chunked's final empty chunk).
        pub complete: bool,
    }

    impl Seen {
        pub fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.as_str())
        }
    }

    async fn fill(tcp: &mut tokio::net::TcpStream, rest: &mut Vec<u8>, want: usize) {
        let mut chunk = [0u8; 65536];
        while rest.len() < want {
            let n = tcp.read(&mut chunk).await.unwrap_or(0);
            if n == 0 {
                return;
            }
            rest.extend_from_slice(&chunk[..n]);
        }
    }

    /// A plain-HTTP server that answers every request with `status` and records it, reading
    /// `Content-Length` and chunked bodies to the end.
    pub(crate) async fn dav_server(status: u16) -> (u16, Arc<Mutex<Vec<Seen>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let log = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut tcp, _)) = listener.accept().await else {
                    return;
                };
                let log = log.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 65536];
                    let head_end = loop {
                        let n = tcp.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break i + 4;
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                    let mut lines = head.split("\r\n");
                    let line = lines.next().unwrap_or_default().to_string();
                    let headers: Vec<(String, String)> = lines
                        .filter_map(|l| l.split_once(':'))
                        .map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_string()))
                        .collect();
                    let get =
                        |k: &str| headers.iter().find(|(h, _)| h == k).map(|(_, v)| v.clone());
                    let mut rest = buf[head_end..].to_vec();
                    let mut complete = true;
                    let body_len = if let Some(len) = get("content-length") {
                        let len: usize = len.parse().unwrap_or(0);
                        fill(&mut tcp, &mut rest, len).await;
                        complete = rest.len() >= len;
                        rest.len().min(len)
                    } else if get("transfer-encoding").is_some_and(|v| v.contains("chunked")) {
                        complete = false;
                        let mut total = 0usize;
                        loop {
                            let Some(i) = rest.windows(2).position(|w| w == b"\r\n") else {
                                let before = rest.len();
                                fill(&mut tcp, &mut rest, before + 1).await;
                                if rest.len() == before {
                                    break;
                                }
                                continue;
                            };
                            let size = usize::from_str_radix(
                                String::from_utf8_lossy(&rest[..i]).trim(),
                                16,
                            )
                            .unwrap_or(0);
                            fill(&mut tcp, &mut rest, i + 2 + size + 2).await;
                            let end = (i + 2 + size + 2).min(rest.len());
                            rest.drain(..end);
                            if size == 0 {
                                complete = end == i + 4;
                                break;
                            }
                            total += size;
                        }
                        total
                    } else {
                        0
                    };
                    log.lock().unwrap().push(Seen {
                        line,
                        headers,
                        body_len,
                        complete,
                    });
                    let reply = format!(
                        "HTTP/1.1 {status} X\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                    );
                    let _ = tcp.write_all(reply.as_bytes()).await;
                });
            }
        });
        (port, seen)
    }

    pub(crate) fn target(port: u16) -> DavTarget {
        DavTarget {
            base: format!("http://127.0.0.1:{port}/dav/"),
            username: "me".into(),
            password: "pw".into(),
            client: crate::storage::tls::client_for(None).unwrap(),
        }
    }

    #[tokio::test]
    async fn move_dir_sends_one_move_without_overwrite() {
        let (port, seen) = dav_server(201).await;
        move_dir(&target(port), "/Photos 2024", "/Archive/Photos")
            .await
            .unwrap();
        let got = seen.lock().unwrap()[0].clone();
        assert_eq!(got.line, "MOVE /dav/Photos%202024/ HTTP/1.1");
        assert_eq!(
            got.header("destination"),
            Some(format!("http://127.0.0.1:{port}/dav/Archive/Photos/").as_str())
        );
        assert_eq!(got.header("overwrite"), Some("F"));
        assert!(got
            .header("authorization")
            .is_some_and(|a| a.starts_with("Basic ")));
    }

    #[tokio::test]
    async fn move_dir_reports_a_refusal() {
        let (port, _) = dav_server(412).await;
        let err = move_dir(&target(port), "/a", "/b").await.unwrap_err();
        assert!(err.contains("already exists"), "{err}");
    }

    #[test]
    fn status_error_maps_webdav_replies() {
        use crate::transfers::model::{JobError, DEST_CHANGED};
        assert_eq!(status_error(201), None);
        assert_eq!(status_error(204), None);
        assert!(matches!(status_error(401), Some(JobError::Operation(_))));
        assert_eq!(
            status_error(412),
            Some(JobError::Operation(DEST_CHANGED.into()))
        );
        assert!(matches!(status_error(507), Some(JobError::Connection(_))));
    }

    async fn upload(status: u16, opts: crate::transfers::io::WriteOpts, size: usize) -> Seen {
        use crate::transfers::io::{copy, Side};
        let (port, seen) = dav_server(status).await;
        let dir = std::env::temp_dir().join(format!("shetu-dav-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.bin");
        std::fs::write(&src, vec![7u8; size]).unwrap();
        let side = Side::Remote(crate::storage::Remote {
            op: opendal::Operator::new(opendal::services::Memory::default()).unwrap(),
            dav: Some(Arc::new(target(port))),
        });
        copy(
            &Side::Local,
            &src.display().to_string(),
            &side,
            "/big file.bin",
            0,
            &tokio_util::sync::CancellationToken::new(),
            opts,
            |_| {},
        )
        .await
        .unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        let got = seen.lock().unwrap()[0].clone();
        got
    }

    #[tokio::test]
    async fn streaming_put_sends_the_whole_body_in_chunks() {
        let got = upload(
            201,
            crate::transfers::io::WriteOpts {
                mtime: 1_700_000_000,
                if_not_exists: false,
                len: None,
            },
            20 * 1024 * 1024,
        )
        .await;
        assert_eq!(got.line, "PUT /dav/big%20file.bin HTTP/1.1");
        assert_eq!(got.body_len, 20 * 1024 * 1024);
        assert_eq!(got.header("x-oc-mtime"), Some("1700000000"));
        assert_eq!(got.header("if-none-match"), None);
    }

    #[tokio::test]
    async fn if_not_exists_sends_if_none_match() {
        let got = upload(
            201,
            crate::transfers::io::WriteOpts {
                mtime: 0,
                if_not_exists: true,
                len: None,
            },
            10,
        )
        .await;
        assert_eq!(got.header("if-none-match"), Some("*"));
        assert_eq!(got.header("x-oc-mtime"), None);
    }

    #[tokio::test]
    async fn upload_sends_its_length() {
        let got = upload(
            201,
            crate::transfers::io::WriteOpts {
                mtime: 0,
                if_not_exists: false,
                len: Some(4096),
            },
            4096,
        )
        .await;
        assert_eq!(got.header("content-length"), Some("4096"));
        assert_eq!(got.header("transfer-encoding"), None);
        assert!(got.complete);
    }

    #[tokio::test]
    async fn a_stopped_upload_never_reaches_the_server_complete() {
        for len in [Some(1_000_000u64), None] {
            let (port, seen) = dav_server(201).await;
            let t = target(port);
            let mut up = t.start_put(
                "/half.bin",
                crate::transfers::io::WriteOpts {
                    mtime: 0,
                    if_not_exists: false,
                    len,
                },
            );
            up.send(vec![1u8; 65536]).await.unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            up.abort();
            drop(up);
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            assert!(
                !seen.lock().unwrap().iter().any(|s| s.complete),
                "len {len:?}: {:?}",
                seen.lock().unwrap()
            );
        }
    }

    #[tokio::test]
    async fn an_upload_to_a_server_that_stops_reading_fails() {
        // Accepts the connection, then never reads.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let held = listener.accept().await;
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            drop(held);
        });
        let t = target(port);
        let mut up = t.start_put_stalling(
            "/stuck.bin",
            crate::transfers::io::WriteOpts::default(),
            std::time::Duration::from_millis(300),
        );
        let started = std::time::Instant::now();
        let mut failed = None;
        for _ in 0..400 {
            if let Err(e) = up.send(vec![0u8; 1 << 20]).await {
                failed = Some(e);
                break;
            }
        }
        assert!(
            matches!(
                failed,
                Some(crate::transfers::model::JobError::Connection(_))
            ),
            "{failed:?}"
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
    }

    #[tokio::test]
    async fn an_upload_the_server_never_answers_fails() {
        // Reads every byte, then never replies.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let (mut tcp, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 8192];
            while tcp.read(&mut buf).await.is_ok_and(|n| n > 0) {}
        });
        let t = target(port);
        let mut up = t.start_put_stalling(
            "/quiet.bin",
            crate::transfers::io::WriteOpts::default(),
            std::time::Duration::from_millis(300),
        );
        up.send(vec![0u8; 1024]).await.unwrap();
        let got = tokio::time::timeout(std::time::Duration::from_secs(10), up.finish()).await;
        assert!(
            matches!(
                got,
                Ok(Err(crate::transfers::model::JobError::Connection(_)))
            ),
            "{got:?}"
        );
    }
}
