use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tauri_plugin_keyring_store::KeyringExt;

pub const DEFAULT_BASE_URL: &str = "http://localhost:8080";
pub const REFRESH_TOKEN_ACCOUNT: &str = "auth.refresh_token";
pub const SESSION_REVOKED_EVENT: &str = "http://session-revoked";
pub const NETWORK_ERROR_MESSAGE: &str =
    "Cannot reach the server. Check that it is running and your connection is online.";
const REFRESH_WAIT_MS: u64 = 50;
const REFRESH_WAIT_MAX_STEPS: u32 = 160;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct RequestLogEntry {
    pub at: u64,
    pub method: String,
    pub path: String,
    pub status: u16,
    pub error: Option<String>,
}

#[derive(Clone, Default)]
pub struct HttpState {
    pub access_token: Arc<Mutex<Option<String>>>,
    pub base_url: Arc<Mutex<String>>,
    pub refreshing: Arc<AtomicBool>,
    pub request_log: Arc<Mutex<Vec<RequestLogEntry>>>,
}

impl HttpState {
    pub fn new(base_url: String) -> Self {
        Self {
            base_url: Arc::new(Mutex::new(base_url)),
            ..Default::default()
        }
    }
    pub fn token(&self) -> Option<String> {
        self.access_token.lock().unwrap().clone()
    }
    pub fn set_token(&self, token: Option<String>) {
        *self.access_token.lock().unwrap() = token;
    }
    pub fn base_url(&self) -> String {
        self.base_url.lock().unwrap().clone()
    }
    pub fn set_base_url(&self, url: String) {
        *self.base_url.lock().unwrap() = url;
    }
    pub fn is_refreshing(&self) -> bool {
        self.refreshing.load(Ordering::SeqCst)
    }
    pub fn begin_refresh(&self) -> bool {
        self.refreshing
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
    pub fn end_refresh(&self) {
        self.refreshing.store(false, Ordering::SeqCst);
    }
    pub fn push_log(&self, entry: RequestLogEntry) {
        let mut log = self.request_log.lock().unwrap();
        log.push(entry);
        while log.len() > 50 {
            log.remove(0);
        }
    }
    pub fn request_log(&self) -> Vec<RequestLogEntry> {
        self.request_log.lock().unwrap().clone()
    }
}

pub trait RefreshProvider: Send + Sync {
    fn get_refresh_token(&self) -> Option<String>;
    fn persist_rotated_token(&self, token: &str);
    fn clear(&self);
}

/// Production provider: reads/writes the OS keychain via the keyring-store
/// plugin (same `auth.refresh_token` account the JS side uses — the shared
/// KeyringStore applies the identical service prefix to both).
pub struct KeyringRefreshProvider {
    pub app: AppHandle,
}

impl RefreshProvider for KeyringRefreshProvider {
    fn get_refresh_token(&self) -> Option<String> {
        self.app
            .keyring()
            .store
            .get_password(REFRESH_TOKEN_ACCOUNT)
            .ok()
            .flatten()
    }
    fn persist_rotated_token(&self, token: &str) {
        let _ = self
            .app
            .keyring()
            .store
            .set_password(REFRESH_TOKEN_ACCOUNT, token);
    }
    fn clear(&self) {
        let _ = self.app.keyring().store.delete(REFRESH_TOKEN_ACCOUNT);
    }
}

#[derive(Debug, PartialEq)]
pub enum HttpErrorKind {
    Network,
    SessionExpired,
    /// 4xx/5xx — carries the server body so 409/400 error envelopes reach the forms.
    Http(u16, String),
}

#[derive(Debug, PartialEq)]
enum RefreshOutcome {
    Ok,
    Revoked,
    Failed,
}

#[derive(Debug)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

pub struct HttpClient {
    state: HttpState,
    refresh: Arc<dyn RefreshProvider>,
    client: reqwest::Client,
}

impl HttpClient {
    pub fn new(state: HttpState, refresh: Arc<dyn RefreshProvider>) -> Self {
        Self {
            state,
            refresh,
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("reqwest client builds"),
        }
    }

    pub async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        auth: bool,
    ) -> Result<HttpResponse, HttpErrorKind> {
        let url = format!(
            "{}/{}",
            self.state.base_url().trim_end_matches('/'),
            path.trim_start_matches('/')
        );
        let m = reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::GET);
        let builder = |token: Option<&String>| {
            let mut b = self.client.request(m.clone(), &url);
            if let Some(bd) = &body {
                b = b.json(bd);
            }
            if let Some(t) = token {
                b = b.bearer_auth(t);
            }
            b
        };

        let first = self
            .send(builder(self.state.token().as_ref()).build().expect("request builds"))
            .await?;
        let (mut status, mut text) = first;

        if auth && status == 401 && self.has_session() {
            match self.refresh_once().await {
                RefreshOutcome::Ok => {
                    if let Some(token) = self.state.token() {
                        let second = self
                            .send(builder(Some(&token)).build().expect("request builds"))
                            .await?;
                        (status, text) = second;
                        if status == 401 {
                            // retried with a fresh access token and STILL 401:
                            // the session is gone for real
                            self.state.push_log(RequestLogEntry {
                                at: now_ms(),
                                method: method.to_string(),
                                path: path.to_string(),
                                status,
                                error: Some("session revoked".into()),
                            });
                            return Err(HttpErrorKind::SessionExpired);
                        }
                    }
                }
                RefreshOutcome::Revoked => {
                    self.state.push_log(RequestLogEntry {
                        at: now_ms(),
                        method: method.to_string(),
                        path: path.to_string(),
                        status,
                        error: Some("session revoked".into()),
                    });
                    return Err(HttpErrorKind::SessionExpired);
                }
                RefreshOutcome::Failed => {
                    // Refresh could not run (no refresh token, server hiccup):
                    // surface the original 401 body — e.g. a wrong-password
                    // login on a machine with no session at all
                }
            }
        }

        self.state.push_log(RequestLogEntry {
            at: now_ms(),
            method: method.to_string(),
            path: path.to_string(),
            status,
            error: None,
        });
        if status >= 400 {
            Err(HttpErrorKind::Http(status, text))
        } else {
            Ok(HttpResponse { status, body: text })
        }
    }

    /// A "session" exists when we hold an access token or a refresh token.
    /// Without one (login/recovery screens, fresh install), 401s are the
    /// server's own verdict (bad credentials, bad recovery code…) and must
    /// reach the forms verbatim — never "session expired".
    fn has_session(&self) -> bool {
        self.state.token().is_some() || self.refresh.get_refresh_token().is_some()
    }

    async fn send(&self, req: reqwest::Request) -> Result<(u16, String), HttpErrorKind> {
        let res = self.client.execute(req).await.map_err(|_| HttpErrorKind::Network)?;
        let status = res.status().as_u16();
        let text = res.text().await.unwrap_or_default();
        Ok((status, text))
    }

    async fn refresh_once(&self) -> RefreshOutcome {
        if !self.state.begin_refresh() {
            // Another caller is refreshing; wait for it, then reuse the result.
            for _ in 0..REFRESH_WAIT_MAX_STEPS {
                if !self.state.is_refreshing() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(REFRESH_WAIT_MS)).await;
            }
            return if self.state.token().is_some() {
                RefreshOutcome::Ok
            } else {
                RefreshOutcome::Failed
            };
        }

        let outcome = self.do_refresh().await;
        self.state.end_refresh();
        outcome
    }

    async fn do_refresh(&self) -> RefreshOutcome {
        let Some(refresh_token) = self.refresh.get_refresh_token() else {
            return RefreshOutcome::Failed;
        };
        let url = format!(
            "{}/api/v1/auth/refresh",
            self.state.base_url().trim_end_matches('/')
        );
        let res = match self
            .client
            .post(&url)
            .json(&json!({ "refresh_token": refresh_token }))
            .send()
            .await
        {
            Ok(r) => r,
            Err(_) => return RefreshOutcome::Failed,
        };
        let status = res.status().as_u16();
        let text = res.text().await.unwrap_or_default();
        if status == 401 {
            self.refresh.clear();
            self.state.set_token(None);
            return RefreshOutcome::Revoked;
        }
        if status != 200 {
            return RefreshOutcome::Failed;
        }
        let data = match serde_json::from_str::<Value>(&text) {
            Ok(v) => v.get("data").cloned().unwrap_or(v),
            Err(_) => return RefreshOutcome::Failed,
        };
        let Some(new_access) = data.get("access_token").and_then(Value::as_str) else {
            return RefreshOutcome::Failed;
        };
        if let Some(new_refresh) = data.get("refresh_token").and_then(Value::as_str) {
            // Persist NOW: the server's reuse detection would otherwise revoke
            // the stored copy and log the user out on the next launch.
            self.refresh.persist_rotated_token(new_refresh);
        }
        self.state.set_token(Some(new_access.to_string()));
        RefreshOutcome::Ok
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Single entry point for all webview HTTP. Contract:
/// - `Ok((status, body))` for ANY HTTP response, including 4xx/5xx (the body
///   carries the server error envelope the forms surface). A 401 on a machine
///   with no session (login/recovery screens) is passed through verbatim —
///   it is the server's verdict, not ours.
/// - `Err("network:...")` — offline classification (connection refused,
///   timeout, DNS).
/// - `Err("auth:...")` — the SESSION was revoked: we held tokens, refreshed,
///   and the refresh token itself was rejected. Emits `http://session-revoked`
///   so the webview tears the session down.
#[tauri::command]
pub async fn http_request(
    app: AppHandle,
    state: tauri::State<'_, HttpState>,
    method: String,
    path: String,
    body: Option<Value>,
    auth: Option<bool>,
) -> Result<(u16, String), String> {
    let client = HttpClient::new(
        state.inner().clone(),
        Arc::new(KeyringRefreshProvider { app: app.clone() }),
    );
    match client.request(&method, &path, body, auth.unwrap_or(true)).await {
        Ok(res) => Ok((res.status, res.body)),
        Err(HttpErrorKind::Network) => Err(format!("network:{NETWORK_ERROR_MESSAGE}")),
        Err(HttpErrorKind::SessionExpired) => {
            let _ = app.emit(SESSION_REVOKED_EVENT, ());
            Err("auth:session-expired. Please sign in again.".to_string())
        }
        Err(HttpErrorKind::Http(status, body)) => Ok((status, body)),
    }
}

#[tauri::command]
pub fn set_auth_tokens(
    app: AppHandle,
    state: tauri::State<'_, HttpState>,
    access_token: String,
    refresh_token: Option<String>,
) -> Result<(), String> {
    state.set_token(Some(access_token));
    if let Some(rt) = refresh_token {
        KeyringRefreshProvider { app }.persist_rotated_token(&rt);
    }
    Ok(())
}

#[tauri::command]
pub fn clear_auth_tokens(state: tauri::State<'_, HttpState>) -> Result<(), String> {
    state.set_token(None);
    Ok(())
}

#[tauri::command]
pub fn set_base_url(url: String, state: tauri::State<'_, HttpState>) -> Result<(), String> {
    state.set_base_url(url);
    Ok(())
}

#[tauri::command]
pub fn get_request_log(
    state: tauri::State<'_, HttpState>,
) -> Result<Vec<RequestLogEntry>, String> {
    Ok(state.request_log())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    struct MemoryRefresh {
        token: Mutex<Option<String>>,
        persisted: Mutex<Vec<String>>,
    }

    impl RefreshProvider for MemoryRefresh {
        fn get_refresh_token(&self) -> Option<String> {
            self.token.lock().unwrap().clone()
        }
        fn persist_rotated_token(&self, t: &str) {
            self.persisted.lock().unwrap().push(t.to_string());
        }
        fn clear(&self) {
            *self.token.lock().unwrap() = None;
        }
    }

    fn mem_refresh(token: Option<&str>) -> Arc<MemoryRefresh> {
        Arc::new(MemoryRefresh {
            token: Mutex::new(token.map(str::to_string)),
            persisted: Mutex::new(vec![]),
        })
    }

    /// Minimal mock HTTP server: responds per-path via a handler closure.
    /// Real OS socket; keeps count of requests seen.
    fn spawn_mock(
        handler: impl Fn(&str) -> (u16, String) + Send + 'static,
    ) -> (String, Arc<std::sync::atomic::AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let hits2 = hits.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { break };
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = req
                    .lines()
                    .next()
                    .unwrap_or("")
                    .split(' ')
                    .nth(1)
                    .unwrap_or("")
                    .to_string();
                hits2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let (status, body) = handler(&path);
                let resp = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = s.write_all(resp.as_bytes());
                let _ = s.flush();
            }
        });
        (format!("http://{addr}"), hits)
    }

    #[tokio::test]
    async fn test_http_request_basic_get() {
        let (url, _) = spawn_mock(|_| (200, r#"{"ok":true}"#.to_string()));
        let state = HttpState::new(url);
        let client = HttpClient::new(state.clone(), mem_refresh(None));
        let res = client.request("GET", "/api/v1/ping", None, false).await.unwrap();
        assert_eq!(res.status, 200);
        assert!(res.body.contains("ok"));
        let log = state.request_log();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].status, 200);
    }

    #[tokio::test]
    async fn test_refresh_occurs_once_on_401_and_retries() {
        let refresh_body = r#"{"data":{"access_token":"a2","refresh_token":"r2"}}"#.to_string();
        let first_original = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let first_original2 = first_original.clone();
        let (url, hits) = spawn_mock(move |path| {
            if path == "/api/v1/auth/refresh" {
                (200, refresh_body.clone())
            } else if first_original2.fetch_add(1, Ordering::SeqCst) == 0 {
                (401, "{}".to_string())
            } else {
                (200, r#"{"data":{"access_token":"a2","refresh_token":"r2"}}"#.to_string())
            }
        });
        let state = HttpState::new(url);
        state.set_token(Some("a1".into()));
        let refresh = mem_refresh(Some("r1"));
        let client = HttpClient::new(state, refresh.clone());
        let res = client.request("GET", "/api/v1/a", None, true).await.unwrap();
        assert_eq!(res.status, 200);
        assert_eq!(*refresh.persisted.lock().unwrap(), vec!["r2".to_string()]);
        // original 401 + refresh + retry
        assert_eq!(hits.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn test_single_flight_concurrent_401s() {
        // Everything 401s (including /refresh). The initiator discovers the
        // refresh token is revoked → SessionExpired (fires the revoked event
        // upstream); the waiter sees the session already torn down and falls
        // through to the plain 401 passthrough. Either request can initiate
        // the refresh. Exactly one refresh call.
        let (url, hits) = spawn_mock(|_| (401, r#"{"error":{"code":"UNAUTHORIZED","message":"x"}}"#.to_string()));
        let state = Arc::new(HttpState::new(url));
        state.set_token(Some("a1".into()));
        let client = Arc::new(HttpClient::new(
            (*state).clone(),
            mem_refresh(Some("r1")),
        ));
        let c1 = client.clone();
        let c2 = client.clone();
        let (r1, r2) = tokio::join!(
            c1.request("GET", "/api/v1/a", None, true),
            c2.request("GET", "/api/v1/b", None, true)
        );
        assert!(
            (matches!(r1, Err(HttpErrorKind::SessionExpired))
                && matches!(r2, Err(HttpErrorKind::Http(401, _))))
                || (matches!(r2, Err(HttpErrorKind::SessionExpired))
                    && matches!(r1, Err(HttpErrorKind::Http(401, _))))
        );
        // 2 originals + exactly 1 refresh
        assert_eq!(hits.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn test_revoked_refresh_returns_session_expired() {
        let (url, _) = spawn_mock(|_| (401, "{}".to_string()));
        let state = HttpState::new(url);
        state.set_token(Some("a1".into()));
        let refresh = mem_refresh(Some("r1"));
        let client = HttpClient::new(state, refresh.clone());
        let err = client.request("GET", "/api/v1/a", None, true).await.unwrap_err();
        assert_eq!(err, HttpErrorKind::SessionExpired);
        assert!(refresh.get_refresh_token().is_none()); // cleared
    }

    #[tokio::test]
    async fn test_network_error_classification() {
        let state = HttpState::new("http://127.0.0.1:1".into()); // closed port
        let client = HttpClient::new(state, mem_refresh(None));
        let err = client.request("GET", "/api/v1/ping", None, false).await.unwrap_err();
        assert_eq!(err, HttpErrorKind::Network);
    }

    #[tokio::test]
    async fn test_401_without_session_passes_through() {
        let body = r#"{"error":{"code":"UNAUTHORIZED","message":"invalid credentials"}}"#.to_string();
        let (url, _) = spawn_mock(move |_| (401, body.clone()));
        let state = HttpState::new(url);
        let client = HttpClient::new(state, mem_refresh(None)); // no tokens at all
        let err = client
            .request("POST", "/api/v1/auth/login", Some(json!({})), true)
            .await
            .unwrap_err();
        assert_eq!(
            err,
            HttpErrorKind::Http(401, r#"{"error":{"code":"UNAUTHORIZED","message":"invalid credentials"}}"#.to_string())
        );
    }

    #[tokio::test]
    async fn test_401_with_stale_token_but_no_refresh_passes_through() {
        let (url, _) = spawn_mock(|_| {
            (
                401,
                r#"{"error":{"code":"UNAUTHORIZED","message":"invalid credentials"}}"#.to_string(),
            )
        });
        let state = HttpState::new(url);
        state.set_token(Some("expired-access".into()));
        let client = HttpClient::new(state, mem_refresh(None)); // no refresh token
        let err = client.request("GET", "/api/v1/a", None, true).await.unwrap_err();
        assert_eq!(
            err,
            HttpErrorKind::Http(
                401,
                r#"{"error":{"code":"UNAUTHORIZED","message":"invalid credentials"}}"#.to_string()
            )
        );
    }

    #[tokio::test]
    async fn test_refresh_failure_passes_through_original_401() {
        // Original request 401s; the refresh attempt itself fails (500):
        // the original 401 body must surface — not "session expired".
        let (url, _) = spawn_mock(|path| {
            if path == "/api/v1/auth/refresh" {
                (500, r#"{"error":{"code":"INTERNAL_ERROR","message":"boom"}}"#.to_string())
            } else {
                (
                    401,
                    r#"{"error":{"code":"UNAUTHORIZED","message":"invalid credentials"}}"#.to_string(),
                )
            }
        });
        let state = HttpState::new(url);
        state.set_token(Some("a1".into()));
        let client = HttpClient::new(state, mem_refresh(Some("r1")));
        let err = client.request("POST", "/api/v1/auth/login", Some(json!({})), true).await.unwrap_err();
        assert_eq!(
            err,
            HttpErrorKind::Http(
                401,
                r#"{"error":{"code":"UNAUTHORIZED","message":"invalid credentials"}}"#.to_string()
            )
        );
    }

    #[tokio::test]
    async fn test_http_4xx_is_http_error_with_body() {
        let (url, _) = spawn_mock(|_| (409, r#"{"error":"CONFLICT"}"#.to_string()));
        let state = HttpState::new(url);
        let client = HttpClient::new(state, mem_refresh(None));
        let err = client
            .request("POST", "/api/v1/auth/register", Some(json!({})), false)
            .await
            .unwrap_err();
        assert_eq!(
            err,
            HttpErrorKind::Http(409, r#"{"error":"CONFLICT"}"#.to_string())
        );
    }
}
