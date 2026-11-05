//! File logging for bug reports: one rotating log in the OS log folder,
//! scrubbed of secrets and identifying values, plus a crash marker so the
//! next launch can offer to export the log.

use regex::Regex;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, OnceLock};
use tauri::plugin::TauriPlugin;
use tauri::{Manager, Runtime};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

const LOG_FILE: &str = "terra";
const CRASH_MARKER: &str = "crash.marker";

static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

// Order matters: whole tokens and URLs first, so the IP/email rules don't split them.
static SCRUBBERS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        (
            r#"(?i)((?:password|passphrase|secret|token)"?\s*[:=]\s*"?)[^\s",}]+"#,
            "${1}[redacted]",
        ),
        (r#"(?i)(bearer)\s+[^\s"']+"#, "${1} [redacted]"),
        (r"eyJ[\w-]*\.[\w-]+\.[\w-]*", "[token]"),
        (
            r"\b([a-z][a-z0-9+.-]*://)(?:[^/\s@]*@)?[^/\s:?#)]+",
            "${1}[host]",
        ),
        (r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", "[user@host]"),
        (
            r"\b[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4})*::(?:[0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4}\b",
            "[ip]",
        ),
        (r"\b(?:[0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}\b", "[ip]"),
        (r"\b(?:\d{1,3}\.){3}\d{1,3}\b", "[ip]"),
    ]
    .into_iter()
    .map(|(pattern, replacement)| (Regex::new(pattern).expect("valid scrub regex"), replacement))
    .collect()
});

/// Removes secrets and identifying values (IPs, user@host, URL hosts) from a log line.
/// shortcut: bare hostnames (no scheme, no user@) are not caught; log host IDs, never names.
pub fn scrub(text: &str) -> String {
    SCRUBBERS.iter().fold(text.to_owned(), |acc, (re, rep)| {
        re.replace_all(&acc, *rep).into_owned()
    })
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri_plugin_log::Builder::new()
        .clear_targets()
        .target(Target::new(TargetKind::LogDir {
            file_name: Some(LOG_FILE.into()),
        }))
        .target(Target::new(TargetKind::Stdout))
        // Third-party crates only at warn: their info lines can carry hostnames.
        .level(log::LevelFilter::Warn)
        .level_for("app_lib", log::LevelFilter::Info)
        .level_for(tauri_plugin_log::WEBVIEW_TARGET, log::LevelFilter::Info)
        .max_file_size(1_500_000)
        .rotation_strategy(RotationStrategy::KeepSome(3))
        .format(|out, message, record| {
            // Webview targets carry the forwarding wrapper's location, which is noise.
            let target = if record
                .target()
                .starts_with(tauri_plugin_log::WEBVIEW_TARGET)
            {
                tauri_plugin_log::WEBVIEW_TARGET
            } else {
                record.target()
            };
            out.finish(format_args!(
                "{} {:<5} [{}] {}",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
                record.level(),
                target,
                scrub(&message.to_string())
            ))
        })
        .build()
}

fn system_summary(version: impl std::fmt::Display) -> String {
    format!(
        "Terra {version} on {} {}",
        std::env::consts::OS,
        std::env::consts::ARCH
    )
}

/// Call first thing in `setup`, after the log plugin is registered.
pub fn init<R: Runtime>(app: &tauri::App<R>) {
    if let Ok(dir) = app.path().app_log_dir() {
        let _ = LOG_DIR.set(dir);
    }
    log::info!(
        "--- {} started ---",
        system_summary(&app.package_info().version)
    );
}

pub fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!(
            "crash: {info}\n{}",
            std::backtrace::Backtrace::force_capture()
        );
        log::logger().flush();
        if let Some(dir) = LOG_DIR.get() {
            write_crash_marker_in(dir);
        }
        default_hook(info);
    }));
}

/// Startup failure that ends the process without a panic (e.g. `setup` returned Err).
pub fn fatal(error: impl std::fmt::Display) {
    log::error!("fatal: Terra failed to start: {error}");
    log::logger().flush();
    if let Some(dir) = LOG_DIR.get() {
        write_crash_marker_in(dir);
    }
}

fn write_crash_marker_in(dir: &Path) {
    let _ = std::fs::write(dir.join(CRASH_MARKER), chrono::Local::now().to_rfc3339());
}

fn take_crash_marker_in(dir: &Path) -> bool {
    std::fs::remove_file(dir.join(CRASH_MARKER)).is_ok()
}

fn export_logs_in(dir: &Path, out: &Path, header: &str) -> std::io::Result<()> {
    let active = format!("{LOG_FILE}.log");
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|ext| ext == "log"))
        .collect();
    // Rotated files carry a sortable date; the active file is always newest.
    files.sort_by_key(|p| {
        let name = p
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        (name == active, name)
    });
    let mut writer = std::io::BufWriter::new(std::fs::File::create(out)?);
    writeln!(writer, "{header}")?;
    for file in files {
        writeln!(
            writer,
            "\n===== {} =====",
            file.file_name().unwrap_or_default().to_string_lossy()
        )?;
        writer.write_all(&std::fs::read(&file)?)?;
    }
    writer.flush()
}

/// True once if the previous session crashed; the marker is consumed.
#[tauri::command]
pub fn take_crash_marker(app: tauri::AppHandle) -> bool {
    app.path()
        .app_log_dir()
        .is_ok_and(|dir| take_crash_marker_in(&dir))
}

#[tauri::command]
pub fn export_logs(app: tauri::AppHandle, destination: String) -> Result<(), String> {
    log::logger().flush();
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let header = format!(
        "{} — exported {}",
        system_summary(&app.package_info().version),
        chrono::Local::now().to_rfc3339()
    );
    export_logs_in(&dir, Path::new(&destination), &header).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrub_redacts_identifying_and_secret_values() {
        let cases = [
            (
                "connect to 10.0.0.12:22 failed",
                "connect to [ip]:22 failed",
            ),
            ("dial fe80::1ff:fe23:4567:890a refused", "dial [ip] refused"),
            ("auth for root@prod-db.example.com", "auth for [user@host]"),
            (
                "error sending request for url (https://sync.example.com/api/sync)",
                "error sending request for url (https://[host]/api/sync)",
            ),
            (
                "Authorization: Bearer abc.def-ghi",
                "Authorization: Bearer [redacted]",
            ),
            ("token eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl", "token [token]"),
            (
                r#"{"refresh_token":"r1-xyz","password": "hunter2"}"#,
                r#"{"refresh_token":"[redacted]","password": "[redacted]"}"#,
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(scrub(input), expected, "input: {input}");
        }
    }

    #[test]
    fn scrub_keeps_ordinary_text() {
        let text = "app_lib::db::open failed at src/db.rs:42 in v0.0.11 after 12:30:05";
        assert_eq!(scrub(text), text);
    }

    #[test]
    fn crash_marker_round_trip() {
        let dir = std::env::temp_dir().join(format!("terra-log-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!take_crash_marker_in(&dir));
        write_crash_marker_in(&dir);
        assert!(take_crash_marker_in(&dir));
        assert!(!take_crash_marker_in(&dir), "marker is consumed once read");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn export_concatenates_logs_oldest_first() {
        let dir = std::env::temp_dir().join(format!("terra-log-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("terra.log"), "new\n").unwrap();
        std::fs::write(dir.join("terra_2026-11-01_10-00-00.log"), "old\n").unwrap();
        std::fs::write(dir.join("unrelated.txt"), "skip\n").unwrap();
        let out = dir.join("out.txt");
        export_logs_in(&dir, &out, "header").unwrap();
        let text = std::fs::read_to_string(&out).unwrap();
        assert!(text.starts_with("header"));
        assert!(text.find("old").unwrap() < text.find("new").unwrap());
        assert!(!text.contains("skip"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
