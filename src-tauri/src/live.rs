//! The live stream: one long-lived `GET /api/v1/live` (Server-Sent Events) per signed-in app.
//! The server only says that something happened; the webview reacts with its normal sync,
//! wipe or session check.

use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use futures::{Stream, StreamExt};
use tokio_util::sync::CancellationToken;

pub const STATUS_EVENT: &str = "live://status";
pub const SIGNAL_EVENT: &str = "live://event";

/// Splits an SSE byte stream into event names. Comments (`: ping`) and `data` are ignored.
#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
    event: Option<String>,
}

impl SseParser {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(pos) = self.buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                if let Some(name) = self.event.take() {
                    out.push(name);
                }
            } else if let Some(name) = line.strip_prefix("event:") {
                self.event = Some(name.trim().to_string());
            }
        }
        out
    }
}

/// Reconnect delay: 1, 2, 4 … seconds, capped at 60.
pub fn backoff(attempt: u32) -> Duration {
    Duration::from_secs((1u64 << attempt.min(6)).min(60))
}

#[derive(Debug, Clone, PartialEq)]
pub enum LiveSignal {
    Connected,
    Disconnected,
    Event(String),
    SessionExpired,
}

pub type ByteStream = Pin<Box<dyn Stream<Item = Result<Vec<u8>, ()>> + Send>>;

/// What opening the stream produced.
pub enum Opened {
    Stream(ByteStream),
    /// The server answered with an error status (404 old server, 403/410 deletion, …).
    Status(u16),
    Network,
    SessionExpired,
}

pub struct LiveTimings {
    /// A stream silent this long (no ping either) is treated as dead, e.g. after sleep.
    pub idle: Duration,
    /// Wait before asking an old server (404) again.
    pub not_found_wait: Duration,
    /// Scales `backoff` (one second in production).
    pub unit: Duration,
    /// A stream up this long resets the backoff.
    pub stable_after: Duration,
    /// A clean close after this long (token expiry) reopens at once; a shorter one backs off.
    pub quiet_after: Duration,
}

impl Default for LiveTimings {
    fn default() -> Self {
        Self {
            idle: Duration::from_secs(60),
            not_found_wait: Duration::from_secs(600),
            unit: Duration::from_secs(1),
            stable_after: Duration::from_secs(60),
            quiet_after: Duration::from_secs(30),
        }
    }
}

/// Keeps the stream open until cancelled: reconnects with backoff, reports state changes once,
/// and stops for good on a revoked session or a 403/410.
pub async fn run_live<F, Fut>(
    open: F,
    emit: impl Fn(LiveSignal),
    t: LiveTimings,
    cancel: CancellationToken,
) where
    F: Fn() -> Fut,
    Fut: Future<Output = Opened>,
{
    let mut connected = false;
    let mut attempt: u32 = 0;
    let wait = |d: Duration| {
        let cancel = cancel.clone();
        async move {
            tokio::select! {
                _ = tokio::time::sleep(d) => true,
                _ = cancel.cancelled() => false,
            }
        }
    };
    let set_down = |connected: &mut bool| {
        if *connected {
            *connected = false;
            emit(LiveSignal::Disconnected);
        }
    };
    loop {
        let opened = tokio::select! {
            o = open() => o,
            _ = cancel.cancelled() => {
                // A quiet reopen keeps "connected" until it fails; stopping ends it too.
                set_down(&mut connected);
                return;
            }
        };
        let mut stream = match opened {
            Opened::Stream(s) => s,
            Opened::SessionExpired => {
                set_down(&mut connected);
                emit(LiveSignal::SessionExpired);
                return;
            }
            Opened::Status(403) | Opened::Status(410) => {
                set_down(&mut connected);
                return;
            }
            Opened::Status(404) => {
                set_down(&mut connected);
                if !wait(t.not_found_wait).await {
                    return;
                }
                continue;
            }
            Opened::Status(_) | Opened::Network => {
                set_down(&mut connected);
                if !wait(t.unit * backoff(attempt).as_secs() as u32).await {
                    return;
                }
                attempt += 1;
                continue;
            }
        };
        let started = Instant::now();
        let mut parser = SseParser::default();
        // A clean end is the server closing at token expiry (or restarting): reopen at once
        // and stay "connected" if the new stream comes up.
        let clean_end = loop {
            let next = tokio::select! {
                n = tokio::time::timeout(t.idle, stream.next()) => n,
                _ = cancel.cancelled() => {
                    set_down(&mut connected);
                    return;
                }
            };
            match next {
                Ok(Some(Ok(bytes))) => {
                    for event in parser.push(&bytes) {
                        if event == "ready" {
                            if !connected {
                                connected = true;
                                emit(LiveSignal::Connected);
                            }
                        } else if connected {
                            emit(LiveSignal::Event(event));
                        }
                    }
                }
                Ok(None) => break true,
                Ok(Some(Err(()))) | Err(_) => break false,
            }
        };
        if started.elapsed() >= t.stable_after {
            attempt = 0;
        }
        // A close after a long-lived stream is the planned one at token expiry: reopen at once.
        // A stream closed right away (e.g. evicted) backs off instead of looping.
        if clean_end && connected && started.elapsed() >= t.quiet_after {
            continue;
        }
        set_down(&mut connected);
        if !wait(t.unit * backoff(attempt).as_secs() as u32).await {
            return;
        }
        attempt += 1;
    }
}

/// The running stream's stop switch and generation. Only the current stream may report status,
/// and the check and the report happen under the same lock a restart takes, so a replaced
/// stream can never report after its successor.
#[derive(Default)]
pub struct LiveState {
    inner: Mutex<LiveInner>,
    next: std::sync::atomic::AtomicU64,
}

#[derive(Default)]
struct LiveInner {
    cancel: Option<CancellationToken>,
    current: u64,
}

impl LiveState {
    /// Stops any running stream and returns a fresh switch and generation for the next one.
    pub fn restart(&self) -> (CancellationToken, u64) {
        self.restart_with(|| {})
    }

    /// `restart`, running `reset` under the lock once the new generation is current: the old
    /// stream can no longer report, and the new one can't report before `reset` (e.g. a
    /// "disconnected" status, so a replacement that never connects doesn't leave "Live" showing).
    pub fn restart_with(&self, reset: impl FnOnce()) -> (CancellationToken, u64) {
        let token = CancellationToken::new();
        let generation = self.next.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let mut inner = self.inner.lock().unwrap();
        if let Some(old) = inner.cancel.replace(token.clone()) {
            old.cancel();
        }
        inner.current = generation;
        reset();
        (token, generation)
    }

    /// Stops the running stream. It stays current, so its own Disconnected still reaches the app.
    pub fn stop(&self) {
        if let Some(old) = self.inner.lock().unwrap().cancel.take() {
            old.cancel();
        }
    }

    /// Runs `emit` only if `generation` is the current stream; reports whether it ran.
    pub fn emit_if_current(&self, generation: u64, emit: impl FnOnce()) -> bool {
        let inner = self.inner.lock().unwrap();
        if inner.current != generation {
            return false;
        }
        emit();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    #[test]
    fn sse_parser_handles_chunking() {
        let mut p = SseParser::default();
        let mut got = p.push(b"event: rea");
        got.extend(
            p.push(b"dy\ndata: {}\n\n: ping\n\nevent: changed\r\ndata: {}\r\n\r\nevent: acc"),
        );
        got.extend(p.push(b"ount_changed\ndata: {}\n"));
        got.extend(p.push(b"\n"));
        assert_eq!(got, vec!["ready", "changed", "account_changed"]);
    }

    #[test]
    fn backoff_schedule() {
        let secs: Vec<u64> = (0..8).map(|a| backoff(a).as_secs()).collect();
        assert_eq!(secs, vec![1, 2, 4, 8, 16, 32, 60, 60]);
    }

    fn quick() -> LiveTimings {
        LiveTimings {
            idle: Duration::from_millis(100),
            not_found_wait: Duration::from_millis(400),
            unit: Duration::from_millis(5),
            stable_after: Duration::from_secs(60),
            quiet_after: Duration::from_millis(20),
        }
    }

    fn chunks(parts: &[&'static str], then_hang: bool) -> Opened {
        let items: Vec<Result<Vec<u8>, ()>> =
            parts.iter().map(|p| Ok(p.as_bytes().to_vec())).collect();
        let s = futures::stream::iter(items);
        if then_hang {
            Opened::Stream(Box::pin(s.chain(futures::stream::pending())))
        } else {
            Opened::Stream(Box::pin(s.chain(futures::stream::iter(vec![Err(())]))))
        }
    }

    /// Runs the loop against a queue of open results; returns what it emitted.
    async fn drive(queue: Vec<Opened>, cancel_after: Duration) -> (Vec<LiveSignal>, usize) {
        let queue = Arc::new(Mutex::new(VecDeque::from(queue)));
        let opens = Arc::new(Mutex::new(0usize));
        let out = Arc::new(Mutex::new(Vec::new()));
        let cancel = CancellationToken::new();
        let stopper = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(cancel_after).await;
            stopper.cancel();
        });
        let (q, o, sink) = (queue.clone(), opens.clone(), out.clone());
        run_live(
            move || {
                let q = q.clone();
                let o = o.clone();
                async move {
                    *o.lock().unwrap() += 1;
                    let next = q.lock().unwrap().pop_front();
                    next.unwrap_or(Opened::Network)
                }
            },
            move |s| sink.lock().unwrap().push(s),
            quick(),
            cancel,
        )
        .await;
        let emitted = out.lock().unwrap().clone();
        let n = *opens.lock().unwrap();
        (emitted, n)
    }

    #[tokio::test]
    async fn live_emits_connected_events_disconnected() {
        let (got, _) = drive(
            vec![chunks(
                &["event: ready\ndata: {}\n\n", "event: changed\ndata: {}\n\n"],
                false,
            )],
            Duration::from_millis(60),
        )
        .await;
        assert_eq!(
            &got[..3],
            &[
                LiveSignal::Connected,
                LiveSignal::Event("changed".into()),
                LiveSignal::Disconnected
            ]
        );
    }

    #[tokio::test]
    async fn live_clean_close_reconnects_quietly() {
        // The server ends the stream at token expiry; the app reconnects with no status flip.
        // Ends cleanly after living past `quiet_after`, like a close at token expiry.
        let first = Opened::Stream(Box::pin(
            futures::stream::iter(vec![Ok(b"event: ready\ndata: {}\n\n".to_vec())]).chain(
                futures::stream::once(tokio::time::sleep(Duration::from_millis(30)))
                    .filter_map(|_| async { None }),
            ),
        ));
        let (got, opens) = drive(
            vec![first, chunks(&["event: ready\ndata: {}\n\n"], true)],
            Duration::from_millis(90),
        )
        .await;
        // One pair only: the final Disconnected comes from stopping. A flip during the
        // reconnect would add another Disconnected/Connected pair in between.
        assert_eq!(got, vec![LiveSignal::Connected, LiveSignal::Disconnected]);
        assert_eq!(opens, 2);
    }

    #[tokio::test]
    async fn live_short_clean_close_backs_off() {
        // A stream closed right after opening (e.g. evicted by an 11th app) must not reopen in a
        // tight loop.
        let short = || {
            Opened::Stream(Box::pin(futures::stream::iter(vec![Ok(
                b"event: ready\ndata: {}\n\n".to_vec(),
            )])))
        };
        let (got, opens) = drive(
            (0..50).map(|_| short()).collect(),
            Duration::from_millis(60),
        )
        .await;
        assert!(opens < 10, "reopened {opens} times in 60 ms");
        assert!(got.contains(&LiveSignal::Disconnected));
    }

    #[tokio::test]
    async fn live_stop_during_quiet_reopen_reports_disconnected() {
        let calls = Arc::new(Mutex::new(0usize));
        let out = Arc::new(Mutex::new(Vec::new()));
        let cancel = CancellationToken::new();
        let stopper = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(80)).await;
            stopper.cancel();
        });
        let (c, sink) = (calls.clone(), out.clone());
        run_live(
            move || {
                let c = c.clone();
                async move {
                    let n = {
                        let mut n = c.lock().unwrap();
                        *n += 1;
                        *n
                    };
                    if n == 1 {
                        // Up long enough for a quiet reopen, then a clean close.
                        Opened::Stream(Box::pin(
                            futures::stream::iter(vec![Ok(b"event: ready\ndata: {}\n\n".to_vec())])
                                .chain(
                                    futures::stream::once(tokio::time::sleep(
                                        Duration::from_millis(30),
                                    ))
                                    .filter_map(|_| async { None }),
                                ),
                        ))
                    } else {
                        futures::future::pending::<Opened>().await
                    }
                }
            },
            move |s| sink.lock().unwrap().push(s),
            quick(),
            cancel,
        )
        .await;
        assert_eq!(
            *out.lock().unwrap(),
            vec![LiveSignal::Connected, LiveSignal::Disconnected]
        );
    }

    #[test]
    fn stop_still_lets_the_stream_report_disconnected() {
        let state = LiveState::default();
        let (_, gen) = state.restart();
        state.stop();
        assert!(
            state.emit_if_current(gen, || {}),
            "the stopped stream's own Disconnected must reach the app"
        );
    }

    #[test]
    fn a_replaced_stream_cannot_emit() {
        let state = LiveState::default();
        let (_, old) = state.restart();
        let (_, new) = state.restart();
        assert!(!state.emit_if_current(old, || {}));
        assert!(state.emit_if_current(new, || {}));
    }

    #[test]
    fn a_replacement_resets_status_before_the_new_stream_reports() {
        // An old stream that was connected is replaced; the new one might never connect, so the
        // app must not keep showing "Live" from the old one.
        let state = LiveState::default();
        let (_, old) = state.restart_with(|| {});
        let order = Mutex::new(Vec::new());
        let (_, new) = state.restart_with(|| order.lock().unwrap().push("reset"));
        assert!(!state.emit_if_current(old, || order.lock().unwrap().push("old")));
        state.emit_if_current(new, || order.lock().unwrap().push("new"));
        assert_eq!(*order.lock().unwrap(), vec!["reset", "new"]);
    }

    #[tokio::test]
    async fn a_failed_replacement_leaves_the_app_disconnected() {
        // The old stream is connected; its replacement never connects. The app must end up on
        // "disconnected", not stuck on the old "connected".
        let state = Arc::new(LiveState::default());
        let statuses = Arc::new(Mutex::new(Vec::new()));
        let report = |gen: u64| {
            let (state, statuses) = (state.clone(), statuses.clone());
            move |s: LiveSignal| {
                state.emit_if_current(gen, || statuses.lock().unwrap().push(s));
            }
        };
        let (old_cancel, old) = state.restart_with(|| {});
        let old_task = tokio::spawn(run_live(
            || async { chunks(&["event: ready\ndata: {}\n\n"], true) },
            report(old),
            quick(),
            old_cancel,
        ));
        tokio::time::sleep(Duration::from_millis(20)).await;
        let reset = statuses.clone();
        let (new_cancel, new) =
            state.restart_with(|| reset.lock().unwrap().push(LiveSignal::Disconnected));
        let stopper = new_cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(60)).await;
            stopper.cancel();
        });
        run_live(|| async { Opened::Network }, report(new), quick(), new_cancel).await;
        old_task.await.unwrap();
        assert_eq!(
            *statuses.lock().unwrap(),
            vec![LiveSignal::Connected, LiveSignal::Disconnected]
        );
    }

    #[test]
    fn a_restart_waits_for_an_emission_in_progress() {
        // The old stream passed the check and is emitting: its status must land before the new
        // stream's, never after.
        let state = Arc::new(LiveState::default());
        let (_, old) = state.restart();
        let order = Arc::new(Mutex::new(Vec::new()));
        let (s, o) = (state.clone(), order.clone());
        let emitting = std::thread::spawn(move || {
            s.emit_if_current(old, || {
                std::thread::sleep(Duration::from_millis(50));
                o.lock().unwrap().push("old");
            })
        });
        std::thread::sleep(Duration::from_millis(10));
        let (_, new) = state.restart();
        state.emit_if_current(new, || order.lock().unwrap().push("new"));
        emitting.join().unwrap();
        assert_eq!(*order.lock().unwrap(), vec!["old", "new"]);
    }

    #[tokio::test]
    async fn live_404_waits_long() {
        let (_, opens) = drive(vec![Opened::Status(404)], Duration::from_millis(200)).await;
        assert_eq!(opens, 1, "a missing endpoint must not be retried quickly");
    }

    #[tokio::test]
    async fn live_403_stops() {
        let (got, opens) = drive(vec![Opened::Status(403)], Duration::from_millis(100)).await;
        assert_eq!(opens, 1);
        assert!(got.is_empty());
    }

    #[tokio::test]
    async fn live_idle_stream_reconnects() {
        let (got, opens) = drive(
            vec![chunks(&["event: ready\ndata: {}\n\n"], true)],
            Duration::from_millis(250),
        )
        .await;
        assert!(opens >= 2, "a silent stream must be dropped and reopened");
        assert_eq!(
            &got[..2],
            &[LiveSignal::Connected, LiveSignal::Disconnected]
        );
    }

    #[tokio::test]
    async fn live_stop_cancels_backoff() {
        let (_, opens) = drive(vec![Opened::Network], Duration::from_millis(2)).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(opens, 1, "no reconnect after stop");
    }

    #[tokio::test]
    async fn live_session_expired_stops_and_reports() {
        let (got, opens) = drive(vec![Opened::SessionExpired], Duration::from_millis(100)).await;
        assert_eq!(opens, 1);
        assert_eq!(got, vec![LiveSignal::SessionExpired]);
    }
}
