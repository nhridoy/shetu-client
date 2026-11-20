//! A small in-memory FTP server for tests: enough of RFC 959/3659/4217 for suppaftp and the
//! patched service (USER PASS FEAT PWD CWD TYPE NOOP PASV EPSV MLSD MLST LIST SIZE MDTM REST
//! RETR STOR APPE DELE RNFR RNTO MKD RMD QUIT, and AUTH TLS/PBSZ/PROT when `tls` is set).

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Clone, Debug, PartialEq)]
pub enum Node {
    Dir,
    File(Vec<u8>),
    /// A symlink to another absolute path.
    Link(String),
}

#[derive(Clone)]
pub struct FakeOpts {
    /// Advertise and answer MLSD/MLST.
    pub mlsd: bool,
    /// Accept `LIST -a` (otherwise it answers 550, as some servers do).
    pub list_a: bool,
    /// Refuse `RNTO` onto an existing name.
    pub refuse_rnto_over_existing: bool,
    /// Offer explicit FTPS with this server config.
    pub tls: Option<Arc<rustls::ServerConfig>>,
    /// Answer `AUTH TLS` with 502.
    pub refuse_auth_tls: bool,
    /// The folder a login lands in.
    pub home: String,
    /// Wait this long before answering `RNTO` (after doing it).
    pub rnto_delay: Option<std::time::Duration>,
    /// Close the control connection when `SIZE` arrives.
    pub drop_on_size: bool,
    /// Send only this many bytes of a `RETR`, then answer 426.
    pub retr_abort_after: Option<usize>,
    /// Refuse this many `RNTO`s onto this path (553).
    pub fail_rnto: Option<(String, Arc<AtomicUsize>)>,
    /// Take a `STOR`'s data, then never answer.
    pub silent_after_stor: bool,
}

impl Default for FakeOpts {
    fn default() -> Self {
        Self {
            mlsd: true,
            list_a: true,
            refuse_rnto_over_existing: false,
            tls: None,
            refuse_auth_tls: false,
            home: "/".into(),
            rnto_delay: None,
            drop_on_size: false,
            retr_abort_after: None,
            fail_rnto: None,
            silent_after_stor: false,
        }
    }
}

pub type Tree = Arc<Mutex<BTreeMap<String, Node>>>;

/// A self-signed server config for `localhost`, and its certificate (DER).
pub fn self_signed_tls() -> (Arc<rustls::ServerConfig>, Vec<u8>) {
    let cert = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
    let der = cert.cert.der().to_vec();
    let key = rustls::pki_types::PrivateKeyDer::try_from(cert.signing_key.serialize_der()).unwrap();
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(vec![der.clone().into()], key)
    .unwrap();
    (Arc::new(config), der)
}

pub struct FakeFtp {
    pub port: u16,
    /// Every command received (passwords masked), across connections.
    pub log: Arc<Mutex<Vec<String>>>,
    /// Most control connections open at once.
    pub peak: Arc<AtomicUsize>,
    /// Control connections accepted so far.
    pub connects: Arc<AtomicUsize>,
    pub fs: Tree,
    /// While set, new connections are closed at once.
    pub down: Arc<std::sync::atomic::AtomicBool>,
}

/// The fixed time every entry reports: 2024-01-02 03:04:05 UTC.
pub const MODIFIED: &str = "20240102030405";

impl FakeFtp {
    pub async fn start(opts: FakeOpts) -> FakeFtp {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let log = Arc::new(Mutex::new(Vec::new()));
        let peak = Arc::new(AtomicUsize::new(0));
        let connects = Arc::new(AtomicUsize::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let fs: Tree = Arc::new(Mutex::new(BTreeMap::new()));
        let down = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (l, p, c, f, d) = (
            log.clone(),
            peak.clone(),
            connects.clone(),
            fs.clone(),
            down.clone(),
        );
        tokio::spawn(async move {
            loop {
                let Ok((tcp, _)) = listener.accept().await else {
                    return;
                };
                if d.load(Ordering::SeqCst) {
                    drop(tcp);
                    continue;
                }
                c.fetch_add(1, Ordering::SeqCst);
                let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                p.fetch_max(now, Ordering::SeqCst);
                let session = Session {
                    ctl: Ctl::Plain(tcp),
                    opts: opts.clone(),
                    log: l.clone(),
                    fs: f.clone(),
                    cwd: opts.home.clone(),
                    pasv: None,
                    rest: 0,
                    rnfr: None,
                    prot_p: false,
                };
                let active = active.clone();
                tokio::spawn(async move {
                    session.run().await;
                    active.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
        FakeFtp {
            port,
            log,
            peak,
            connects,
            fs,
            down,
        }
    }

    pub fn put(&self, path: &str, node: Node) {
        self.fs.lock().unwrap().insert(path.to_string(), node);
    }

    pub fn get(&self, path: &str) -> Option<Node> {
        self.fs.lock().unwrap().get(path).cloned()
    }

    pub fn names(&self) -> Vec<String> {
        self.fs.lock().unwrap().keys().cloned().collect()
    }

    pub fn commands(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
}

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

enum Ctl {
    Plain(TcpStream),
    Tls(Box<tokio_rustls::server::TlsStream<TcpStream>>),
    Gone,
}

impl Ctl {
    fn io(&mut self) -> Option<&mut dyn Io> {
        match self {
            Ctl::Plain(s) => Some(s),
            Ctl::Tls(s) => Some(s.as_mut()),
            Ctl::Gone => None,
        }
    }
}

struct Session {
    ctl: Ctl,
    opts: FakeOpts,
    log: Arc<Mutex<Vec<String>>>,
    fs: Tree,
    cwd: String,
    pasv: Option<TcpListener>,
    rest: usize,
    rnfr: Option<String>,
    prot_p: bool,
}

fn join(cwd: &str, arg: &str) -> String {
    let raw = if arg.starts_with('/') {
        arg.to_string()
    } else if cwd == "/" {
        format!("/{arg}")
    } else {
        format!("{cwd}/{arg}")
    };
    let mut parts: Vec<&str> = Vec::new();
    for p in raw.split('/') {
        match p {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            p => parts.push(p),
        }
    }
    format!("/{}", parts.join("/"))
}

fn parent(path: &str) -> &str {
    match path.rfind('/') {
        Some(0) | None => "/",
        Some(i) => &path[..i],
    }
}

fn name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or_default()
}

impl Session {
    async fn say(&mut self, line: &str) {
        if let Some(io) = self.ctl.io() {
            let _ = io.write_all(format!("{line}\r\n").as_bytes()).await;
            let _ = io.flush().await;
        }
    }

    async fn read_line(&mut self) -> Option<String> {
        let io = self.ctl.io()?;
        let mut line = Vec::new();
        loop {
            let b = io.read_u8().await.ok()?;
            if b == b'\n' {
                break;
            }
            if b != b'\r' {
                line.push(b);
            }
        }
        Some(String::from_utf8_lossy(&line).to_string())
    }

    fn node(&self, path: &str) -> Option<Node> {
        if path == "/" {
            return Some(Node::Dir);
        }
        self.fs.lock().unwrap().get(path).cloned()
    }

    /// Follows links (one level is enough for tests).
    fn resolved(&self, path: &str) -> Option<Node> {
        match self.node(path) {
            Some(Node::Link(to)) => self.node(&to),
            n => n,
        }
    }

    fn children(&self, dir: &str) -> Vec<(String, Node)> {
        self.fs
            .lock()
            .unwrap()
            .iter()
            .filter(|(k, _)| parent(k) == dir && k.as_str() != "/")
            .map(|(k, v)| (name(k).to_string(), v.clone()))
            .collect()
    }

    fn list_line(name: &str, node: &Node) -> String {
        match node {
            Node::Dir => format!("drwxr-xr-x 2 owner group 4096 Jan 02 03:04 {name}"),
            Node::File(b) => format!("-rw-r--r-- 1 owner group {} Jan 02 03:04 {name}", b.len()),
            Node::Link(to) => format!(
                "lrwxrwxrwx 1 owner group {} Jan 02 03:04 {name} -> {to}",
                to.len()
            ),
        }
    }

    fn mlsx_line(name: &str, node: &Node) -> String {
        match node {
            Node::Dir => format!("type=dir;modify={MODIFIED}; {name}"),
            Node::File(b) => format!("type=file;size={};modify={MODIFIED}; {name}", b.len()),
            Node::Link(to) => format!("type=OS.unix=slink:{to};modify={MODIFIED}; {name}"),
        }
    }

    /// Opens the pending passive data connection, upgraded when `PROT P` is on.
    async fn data(&mut self) -> Option<Box<dyn Io>> {
        let listener = self.pasv.take()?;
        let (tcp, _) = listener.accept().await.ok()?;
        match (&self.opts.tls, self.prot_p) {
            (Some(cfg), true) => {
                let acceptor = tokio_rustls::TlsAcceptor::from(cfg.clone());
                Some(Box::new(acceptor.accept(tcp).await.ok()?))
            }
            _ => Some(Box::new(tcp)),
        }
    }

    async fn send_data(&mut self, bytes: Vec<u8>) {
        self.say("150 Opening data connection").await;
        let Some(mut data) = self.data().await else {
            self.say("425 Can't open data connection").await;
            return;
        };
        let ok = data.write_all(&bytes).await.is_ok();
        let _ = data.shutdown().await;
        drop(data);
        self.say(if ok {
            "226 Transfer complete"
        } else {
            "426 Transfer aborted"
        })
        .await;
    }

    async fn receive_data(&mut self) -> Option<Vec<u8>> {
        self.say("150 Ok to send data").await;
        let Some(mut data) = self.data().await else {
            self.say("425 Can't open data connection").await;
            return None;
        };
        let mut buf = Vec::new();
        let ok = data.read_to_end(&mut buf).await.is_ok();
        self.say(if ok {
            "226 Transfer complete"
        } else {
            "426 Transfer aborted"
        })
        .await;
        ok.then_some(buf)
    }

    async fn run(mut self) {
        self.say("220 fake ftp").await;
        while let Some(line) = self.read_line().await {
            let (cmd, arg) = match line.split_once(' ') {
                Some((c, a)) => (c.to_ascii_uppercase(), a.to_string()),
                None => (line.to_ascii_uppercase(), String::new()),
            };
            let logged = if cmd == "PASS" {
                "PASS ***".to_string()
            } else {
                line.clone()
            };
            self.log.lock().unwrap().push(logged);
            match cmd.as_str() {
                "AUTH" => {
                    let Some(cfg) = self.opts.tls.clone().filter(|_| !self.opts.refuse_auth_tls)
                    else {
                        self.say("502 AUTH not supported").await;
                        continue;
                    };
                    self.say("234 Proceed with negotiation").await;
                    let Ctl::Plain(tcp) = std::mem::replace(&mut self.ctl, Ctl::Gone) else {
                        return;
                    };
                    match tokio_rustls::TlsAcceptor::from(cfg).accept(tcp).await {
                        Ok(tls) => self.ctl = Ctl::Tls(Box::new(tls)),
                        Err(_) => return,
                    }
                }
                "PBSZ" => self.say("200 PBSZ=0").await,
                "PROT" => {
                    self.prot_p = arg.eq_ignore_ascii_case("P");
                    self.say("200 Protection set").await;
                }
                "USER" => self.say("331 Password required").await,
                "PASS" => {
                    if arg == "pw" {
                        self.say("230 Logged in").await
                    } else {
                        self.say("530 Login incorrect").await
                    }
                }
                "FEAT" => {
                    let mut lines = vec!["211-Features:".to_string()];
                    // RFC 3659: the MLST line advertises MLSD too.
                    if self.opts.mlsd {
                        lines.push(" MLST type*;size*;modify*;".into());
                    }
                    lines.extend([" SIZE".into(), " MDTM".into(), " REST STREAM".into()]);
                    if self.opts.tls.is_some() {
                        lines.push(" AUTH TLS".into());
                    }
                    lines.push("211 End".into());
                    for l in lines {
                        self.say(&l).await;
                    }
                }
                "SYST" => self.say("215 UNIX Type: L8").await,
                "TYPE" => self.say("200 Type set").await,
                "NOOP" => self.say("200 NOOP ok").await,
                "PWD" => {
                    let cwd = self.cwd.clone();
                    self.say(&format!("257 \"{cwd}\" is the current directory"))
                        .await
                }
                "CWD" => {
                    let to = join(&self.cwd, &arg);
                    if matches!(self.resolved(&to), Some(Node::Dir)) {
                        self.cwd = to;
                        self.say("250 Directory changed").await
                    } else {
                        self.say("550 Failed to change directory").await
                    }
                }
                "PASV" | "EPSV" => {
                    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
                    let p = l.local_addr().unwrap().port();
                    self.pasv = Some(l);
                    if cmd == "PASV" {
                        self.say(&format!(
                            "227 Entering Passive Mode (127,0,0,1,{},{})",
                            p >> 8,
                            p & 0xff
                        ))
                        .await
                    } else {
                        self.say(&format!("229 Entering Extended Passive Mode (|||{p}|)"))
                            .await
                    }
                }
                "LIST" | "NLST" => {
                    let mut all = false;
                    let mut target = String::new();
                    for a in arg.split_whitespace() {
                        if a.starts_with('-') {
                            all |= a.contains('a');
                        } else {
                            target = a.to_string();
                        }
                    }
                    if all && !self.opts.list_a {
                        self.pasv = None;
                        self.say("550 -a: No such file or directory").await;
                        continue;
                    }
                    let dir = join(&self.cwd, &target);
                    if !matches!(self.resolved(&dir), Some(Node::Dir)) {
                        self.pasv = None;
                        self.say("550 No such directory").await;
                        continue;
                    }
                    let body: String = self
                        .children(&dir)
                        .into_iter()
                        .filter(|(n, _)| all || !n.starts_with('.'))
                        .map(|(n, node)| Self::list_line(&n, &node) + "\r\n")
                        .collect();
                    self.send_data(body.into_bytes()).await;
                }
                "MLSD" if self.opts.mlsd => {
                    let dir = join(&self.cwd, &arg);
                    let body: String = self
                        .children(&dir)
                        .into_iter()
                        .map(|(n, node)| Self::mlsx_line(&n, &node) + "\r\n")
                        .collect();
                    self.send_data(body.into_bytes()).await;
                }
                "MLST" if self.opts.mlsd => {
                    let path = join(&self.cwd, &arg);
                    match self.node(&path) {
                        Some(node) => {
                            let line = Self::mlsx_line(&path, &node);
                            self.say("250-Listing").await;
                            self.say(&format!(" {line}")).await;
                            self.say("250 End").await
                        }
                        None => self.say("550 No such file").await,
                    }
                }
                "SIZE" if self.opts.drop_on_size => return,
                "SIZE" => match self.resolved(&join(&self.cwd, &arg)) {
                    Some(Node::File(b)) => self.say(&format!("213 {}", b.len())).await,
                    _ => self.say("550 Could not get file size").await,
                },
                "MDTM" => match self.resolved(&join(&self.cwd, &arg)) {
                    Some(_) => self.say(&format!("213 {MODIFIED}")).await,
                    None => self.say("550 No such file").await,
                },
                "REST" => {
                    self.rest = arg.parse().unwrap_or(0);
                    self.say("350 Restart position accepted").await
                }
                "RETR" => {
                    let rest = std::mem::take(&mut self.rest);
                    match self.resolved(&join(&self.cwd, &arg)) {
                        Some(Node::File(b)) => {
                            let body = b[rest.min(b.len())..].to_vec();
                            match self.opts.retr_abort_after {
                                Some(n) => {
                                    self.say("150 Opening data connection").await;
                                    if let Some(mut data) = self.data().await {
                                        let _ = data.write_all(&body[..n.min(body.len())]).await;
                                        let _ = data.shutdown().await;
                                    }
                                    self.say("426 Connection closed; transfer aborted").await
                                }
                                None => self.send_data(body).await,
                            }
                        }
                        _ => {
                            self.pasv = None;
                            self.say("550 Failed to open file").await
                        }
                    }
                }
                "STOR" | "APPE" => {
                    let path = join(&self.cwd, &arg);
                    if !matches!(self.resolved(parent(&path)), Some(Node::Dir)) {
                        self.pasv = None;
                        self.say("553 Could not create file").await;
                        continue;
                    }
                    if self.opts.silent_after_stor {
                        self.say("150 Ok to send data").await;
                        if let Some(mut data) = self.data().await {
                            let mut sink = Vec::new();
                            let _ = data.read_to_end(&mut sink).await;
                        }
                        std::future::pending::<()>().await;
                    }
                    if let Some(bytes) = self.receive_data().await {
                        let mut fs = self.fs.lock().unwrap();
                        let old = match (cmd.as_str(), fs.get(&path)) {
                            ("APPE", Some(Node::File(b))) => b.clone(),
                            _ => Vec::new(),
                        };
                        fs.insert(path, Node::File([old, bytes].concat()));
                    }
                }
                "DELE" => {
                    let path = join(&self.cwd, &arg);
                    let removed = {
                        let mut fs = self.fs.lock().unwrap();
                        match fs.get(&path) {
                            Some(Node::File(_)) | Some(Node::Link(_)) => fs.remove(&path).is_some(),
                            _ => false,
                        }
                    };
                    if removed {
                        self.say("250 Delete operation successful").await
                    } else {
                        self.say("550 Delete operation failed").await
                    }
                }
                "MKD" => {
                    let path = join(&self.cwd, &arg);
                    let made = {
                        let mut fs = self.fs.lock().unwrap();
                        let parent_ok = parent(&path) == "/"
                            || matches!(fs.get(parent(&path)), Some(Node::Dir));
                        if path == "/" || fs.contains_key(&path) || !parent_ok {
                            false
                        } else {
                            fs.insert(path.clone(), Node::Dir);
                            true
                        }
                    };
                    if made {
                        self.say(&format!("257 \"{path}\" created")).await
                    } else {
                        self.say("550 Create directory operation failed").await
                    }
                }
                "RMD" => {
                    let path = join(&self.cwd, &arg);
                    let removed = {
                        let mut fs = self.fs.lock().unwrap();
                        let empty = !fs.keys().any(|k| parent(k) == path);
                        matches!(fs.get(&path), Some(Node::Dir))
                            && empty
                            && fs.remove(&path).is_some()
                    };
                    if removed {
                        self.say("250 Remove directory operation successful").await
                    } else {
                        self.say("550 Remove directory operation failed").await
                    }
                }
                "RNFR" => {
                    let path = join(&self.cwd, &arg);
                    if self.node(&path).is_some() {
                        self.rnfr = Some(path);
                        self.say("350 Ready for RNTO").await
                    } else {
                        self.say("550 RNFR command failed").await
                    }
                }
                "RNTO" => {
                    let Some(from) = self.rnfr.take() else {
                        self.say("503 RNFR required first").await;
                        continue;
                    };
                    let to = join(&self.cwd, &arg);
                    let forced = self.opts.fail_rnto.as_ref().is_some_and(|(p, left)| {
                        *p == to
                            && left
                                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                                    n.checked_sub(1)
                                })
                                .is_ok()
                    });
                    let moved = {
                        let mut fs = self.fs.lock().unwrap();
                        if forced || (fs.contains_key(&to) && self.opts.refuse_rnto_over_existing) {
                            false
                        } else {
                            let keys: Vec<String> = fs
                                .keys()
                                .filter(|k| *k == &from || k.starts_with(&format!("{from}/")))
                                .cloned()
                                .collect();
                            for k in keys {
                                let node = fs.remove(&k).unwrap();
                                fs.insert(format!("{to}{}", &k[from.len()..]), node);
                            }
                            true
                        }
                    };
                    if let Some(delay) = self.opts.rnto_delay {
                        tokio::time::sleep(delay).await;
                    }
                    if moved {
                        self.say("250 Rename successful").await
                    } else {
                        self.say("553 Rename failed").await
                    }
                }
                "QUIT" => {
                    self.say("221 Goodbye").await;
                    return;
                }
                _ => self.say("502 Command not implemented").await,
            }
        }
    }
}
