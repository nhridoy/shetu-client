use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const OAUTH_PORTS: [u16; 3] = [1421, 1422, 1423];
const CALLBACK_TIMEOUT_SECS: u64 = 120;

pub struct OAuthListener {
    listener: Mutex<Option<(u64, TcpListener)>>,
    next_attempt: AtomicU64,
    cancelled: AtomicBool,
}

impl Default for OAuthListener {
    fn default() -> Self {
        Self {
            listener: Mutex::new(None),
            next_attempt: AtomicU64::new(1),
            cancelled: AtomicBool::new(false),
        }
    }
}

#[derive(serde::Serialize)]
pub struct OAuthBind {
    pub port: u16,
    pub attempt: u64,
}

#[tauri::command]
pub async fn bind_oauth_listener(state: tauri::State<'_, OAuthListener>) -> Result<OAuthBind, String> {
    let mut bound = None;
    for port in OAUTH_PORTS {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => {
                bound = Some((port, listener));
                break;
            }
            Err(_) => continue,
        }
    }
    let (port, listener) = bound.ok_or_else(|| {
        "Could not bind a local callback port (1421-1423). \
         Close the app using it, or restart Terra and try again."
            .to_string()
    })?;
    let attempt = state.next_attempt.fetch_add(1, Ordering::Relaxed);
    state.cancelled.store(false, Ordering::Relaxed);
    *state.listener.lock().map_err(|e| e.to_string())? = Some((attempt, listener));
    Ok(OAuthBind { port, attempt })
}

#[tauri::command]
pub async fn await_oauth_callback(
    state: tauri::State<'_, OAuthListener>,
    attempt: u64,
) -> Result<String, String> {
    let cancelled = &state.cancelled;
    let listener = {
        let mut guard = state.listener.lock().map_err(|e| e.to_string())?;
        let current = guard
            .as_ref()
            .ok_or_else(|| "No OAuth listener bound. Call bind_oauth_listener first.".to_string())?;
        if current.0 != attempt {
            return Err(
                "This sign-in attempt was superseded by a newer attempt. Please try again."
                    .to_string(),
            );
        }
        match guard.take() {
            Some((_, listener)) => listener,
            None => return Err("No OAuth listener bound. Start over.".to_string()),
        }
    };
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let url = tokio::time::timeout(
        tokio::time::Duration::from_secs(CALLBACK_TIMEOUT_SECS),
        async move {
            tokio::select! {
                _ = wait_for_cancel(cancelled) => {
                    Err("OAuth sign-in was cancelled.".to_string())
                }
                result = handle_callback(listener, port) => result,
            }
        },
    )
    .await
    .map_err(|_| {
        format!(
            "OAuth callback timed out after {CALLBACK_TIMEOUT_SECS} seconds. Please try again."
        )
    })??;

    Ok(url)
}

async fn wait_for_cancel(flag: &AtomicBool) {
    loop {
        if flag.load(Ordering::Relaxed) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn handle_callback(listener: TcpListener, port: u16) -> Result<String, String> {
    let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
    stream.set_nodelay(true).map_err(|e| e.to_string())?;

    let mut buf = [0u8; 8192];
    let mut data = Vec::new();
    loop {
        let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        data.extend_from_slice(&buf[..n]);
        if data.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }

    let text = String::from_utf8_lossy(&data);
    let request_target = text
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("/");
    let callback_url = format!("http://127.0.0.1:{port}{request_target}");

    let body = "<!DOCTYPE html><html><head><meta charset=\"utf-8\">\
                <title>Terra</title></head>\
                <body style=\"font-family:system-ui;text-align:center;padding:3rem;\">\
                <h2>Authentication complete</h2>\
                <p>You can close this tab and return to Terra.</p>\
                </body></html>";
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stream.flush().await.map_err(|e| e.to_string())?;

    Ok(callback_url)
}

#[tauri::command]
pub fn cancel_oauth_listener(
    state: tauri::State<'_, OAuthListener>,
    attempt: u64,
) -> Result<(), String> {
    let mut guard = state.listener.lock().map_err(|e| e.to_string())?;
    if let Some((current, _)) = guard.as_ref() {
        if *current == attempt {
            *guard = None;
        }
    }
    state.cancelled.store(true, Ordering::Relaxed);
    Ok(())
}