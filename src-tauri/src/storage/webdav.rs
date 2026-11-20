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
                    let body_len = if let Some(len) = get("content-length") {
                        let len: usize = len.parse().unwrap_or(0);
                        fill(&mut tcp, &mut rest, len).await;
                        len
                    } else if get("transfer-encoding").is_some_and(|v| v.contains("chunked")) {
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
}
