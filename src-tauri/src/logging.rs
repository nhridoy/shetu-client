//! File logging for bug reports: one rotating log in the OS log folder,
//! scrubbed of secrets and identifying values, plus a crash marker so the
//! next launch can offer to export the log.

use regex::Regex;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, OnceLock, RwLock};
use tauri::plugin::TauriPlugin;
use tauri::{Manager, Runtime};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

const LOG_FILE: &str = "shetu";
const CRASH_MARKER: &str = "crash.marker";

static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

// Any key that names a credential, e.g. `password`, `refresh_token`, `private_key`.
const SECRET_KEY: &str = r#"(?i)("?[\w-]*(?:password|passphrase|secret|token|private_?key|api_?key|credential)[\w-]*"?\s*[:=]\s*)"#;

// Order matters: whole tokens and URLs first, so the IP/email rules don't split them.
static SCRUBBERS: LazyLock<Vec<(Regex, &'static str)>> =
    LazyLock::new(|| {
        let quoted_secret = format!(r#"{SECRET_KEY}"(?:[^"\\]|\\.)*""#);
        let bare_secret = format!(r#"{SECRET_KEY}[^\s",}}]+"#);
        [
        (quoted_secret.as_str(), r#"${1}"[redacted]""#),
        (bare_secret.as_str(), "${1}[redacted]"),
        (r#"(?i)(bearer)\s+[^\s"']+"#, "${1} [redacted]"),
        (r"eyJ[\w-]*\.[\w-]+\.[\w-]*", "[token]"),
        // URL query strings can carry emails or tokens (e.g. `?email=`).
        (r#"(://[^\s?#)"]*)[?#][^\s)"]*"#, "${1}?[redacted]"),
        (
            r"\b([a-z][a-z0-9+.-]*://)(?:[^/\s@]*@)?[^/\s:?#)]+",
            "${1}[host]",
        ),
        (r"[\w.+-]+(?:@|%40)[\w-]+(?:\.[\w-]+)+", "[user@host]"),
        (
            r"\b[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4})*::(?:[0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4}\b",
            "[ip]",
        ),
        // Leading `::` (e.g. `::1`) and trailing `::` (e.g. `2001:db8::`); the
        // neighbour checks keep Rust paths like `app_lib::db` intact.
        (r"(^|[^\w:])::(?:[0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4}\b", "${1}[ip]"),
        (r"\b[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4})+::([^\w:]|$)", "[ip]${1}"),
        (r"\b(?:[0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}\b", "[ip]"),
        (r"\b(?:\d{1,3}\.){3}\d{1,3}\b", "[ip]"),
    ]
    .into_iter()
    .map(|(pattern, replacement)| (Regex::new(pattern).expect("valid scrub regex"), replacement))
    .collect()
    });

// `name.tld:port`, e.g. `dns lookup prod.example.com:22`.
static HOST_PORT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:[a-zA-Z0-9_-]+\.)+([a-zA-Z]{2,})\.?:(\d{1,5})\b").expect("valid host regex")
});
// `file.ext:line` in panics and stack traces looks like `host:port`; keep it.
const SOURCE_EXTENSIONS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "mjs", "go", "json", "toml", "html", "css",
];

// Hostnames and usernames this session has used, matched as whole words.
static HIDDEN: RwLock<(Vec<String>, Option<Regex>)> = RwLock::new((Vec::new(), None));

// Defaults shared by millions of machines identify no one; hiding them would
// turn "root cause" into "[redacted] cause".
const DEFAULT_NAMES: &[&str] = &[
    "root", "admin", "administrator", "ubuntu", "debian", "centos", "fedora", "ec2-user",
    "azureuser", "opc", "user", "guest", "git", "pi", "vagrant", "localhost",
];
// Fields of decrypted records that name a machine or account.
const RECORD_FIELDS: &[&str] = &["address", "username", "destination_host"];

/// Never show `value` (a hostname or username) in the log, wherever it appears.
/// Values under 3 characters are skipped: they would shred ordinary words.
pub fn hide(value: &str) {
    // `host.example.` (fully qualified) is logged both with and without the dot.
    let value = value.trim().trim_end_matches('.');
    let Ok(mut hidden) = HIDDEN.write() else {
        return;
    };
    if value.chars().count() < 3
        || DEFAULT_NAMES.iter().any(|d| d.eq_ignore_ascii_case(value))
        || hidden.0.iter().any(|v| v == value)
    {
        return;
    }
    let mut values = hidden.0.clone();
    values.push(value.to_owned());
    // Longest first, so `db.example.com` wins over a hidden `db.example`.
    values.sort_by_key(|v| std::cmp::Reverse(v.len()));
    let word = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
    let pattern = values
        .iter()
        .map(|v| {
            // `\b` only where the value's edge is a word character, e.g. not for `-edge-`.
            let start = if word(v.chars().next()) { r"\b" } else { "" };
            let end = if word(v.chars().last()) { r"\b" } else { "" };
            format!("{start}{}{end}", regex::escape(v))
        })
        .collect::<Vec<_>>()
        .join("|");
    // On failure (regex size limit) keep the old regex rather than dropping all redaction.
    if let Ok(re) = Regex::new(&format!("(?i)(?:{pattern})")) {
        *hidden = (values, Some(re));
    }
}

/// Hides the host fields of a decrypted or about-to-be-encrypted record. Every
/// saved host passes through here before Shetu can use it, so before it can be logged.
pub fn hide_record(plaintext: &str) {
    if !plaintext.trim_start().starts_with('{') {
        return;
    }
    let Ok(record) = serde_json::from_str::<serde_json::Value>(plaintext) else {
        return;
    };
    for field in RECORD_FIELDS {
        if let Some(value) = record.get(field).and_then(|v| v.as_str()) {
            hide(value);
        }
    }
}

fn redact_hidden(text: &str) -> String {
    match HIDDEN.read().ok().and_then(|h| h.1.clone()) {
        Some(re) => re.replace_all(text, "[redacted]").into_owned(),
        None => text.to_owned(),
    }
}

/// Removes secrets and identifying values (IPs, user@host, URL hosts) from a log line.
/// Bare hostnames are caught only once registered with [`hide`].
pub fn scrub(text: &str) -> String {
    // Hidden values go last: masking them first would hide keys and emails from SCRUBBERS.
    let scrubbed = SCRUBBERS.iter().fold(text.to_owned(), |acc, (re, rep)| {
        re.replace_all(&acc, *rep).into_owned()
    });
    let scrubbed = HOST_PORT
        .replace_all(&scrubbed, |c: &regex::Captures| {
            if SOURCE_EXTENSIONS.contains(&c[1].to_ascii_lowercase().as_str()) {
                c[0].to_owned()
            } else {
                format!("[host]:{}", &c[2])
            }
        })
        .into_owned();
    redact_hidden(&scrubbed)
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
        "Shetu {version} on {} {}",
        std::env::consts::OS,
        std::env::consts::ARCH
    )
}

/// Register right after [`plugin`], so the crash-marker folder is known
/// before any later plugin or `setup` can fail.
pub fn init_plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("shetu-logging")
        .setup(|app, _api| {
            if let Ok(dir) = app.path().app_log_dir() {
                let _ = LOG_DIR.set(dir);
            }
            log::info!(
                "--- {} started ---",
                system_summary(&app.package_info().version)
            );
            Ok(())
        })
        .build()
}

pub fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!(
            "crash: {info}\n{}",
            std::backtrace::Backtrace::force_capture()
        );
        log::logger().flush();
        // Worker-thread panics (e.g. a tokio task) are logged but don't end the app.
        if std::thread::current().name() == Some("main") {
            if let Some(dir) = LOG_DIR.get() {
                write_crash_marker_in(dir);
            }
        }
        default_hook(info);
    }));
}

/// Startup failure that ends the process without a panic (e.g. `setup` returned Err).
pub fn fatal(error: impl std::fmt::Display) {
    log::error!("fatal: Shetu failed to start: {error}");
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
    // Read everything before creating `out`: it may be one of the source logs.
    let mut parts = Vec::new();
    for file in files {
        match std::fs::read(&file) {
            // Lines written before a host was hidden still name it.
            Ok(bytes) => parts.push((file, redact_hidden(&String::from_utf8_lossy(&bytes)))),
            // Rotation removed it between listing and reading.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    let mut writer = std::io::BufWriter::new(std::fs::File::create(out)?);
    writeln!(writer, "{header}")?;
    for (file, text) in parts {
        writeln!(
            writer,
            "\n===== {} =====",
            file.file_name().unwrap_or_default().to_string_lossy()
        )?;
        writer.write_all(text.as_bytes())?;
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

/// Deletes regular files directly inside `dir`; returns the names that could not be removed.
fn clear_dir_files(dir: &Path) -> Vec<String> {
    let Ok(read) = std::fs::read_dir(dir) else { return Vec::new() };
    read.flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter(|e| std::fs::remove_file(e.path()).is_err())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect()
}

/// Wipes known hosts and logs; returns log files that could not be deleted
/// (the live log file may be locked on Windows).
#[tauri::command]
pub fn reset_device_files(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::ssh::SshSessions>,
) -> Result<Vec<String>, String> {
    state
        .known_hosts
        .lock()
        .map_err(|_| "known_hosts lock poisoned".to_string())?
        .clear();
    log::logger().flush();
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    Ok(clear_dir_files(&dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("shetu-{tag}-{stamp}"))
    }

    #[test]
    fn clear_dir_files_removes_files_and_reports_failures() {
        let dir = tmp_dir("clear");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.log"), "x").unwrap();
        std::fs::write(dir.join("b.log"), "y").unwrap();
        assert!(clear_dir_files(&dir).is_empty());
        assert!(!dir.join("a.log").exists() && !dir.join("b.log").exists());
        assert!(dir.join("sub").is_dir());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_dir_files_missing_dir_is_empty() {
        assert!(clear_dir_files(&tmp_dir("missing")).is_empty());
    }

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
            (
                r#"{"private_key":"secret material","api_key":"k1"}"#,
                r#"{"private_key":"[redacted]","api_key":"[redacted]"}"#,
            ),
            (
                r#"password: "correct horse battery""#,
                r#"password: "[redacted]""#,
            ),
            ("listen ::1 failed", "listen [ip] failed"),
            ("bind [::1]:22", "bind [[ip]]:22"),
            ("prefix 2001:db8:: end", "prefix [ip] end"),
            (
                "url (http://h.example.com:8080/api/v1/users/lookup?email=a%40b.com)",
                "url (http://[host]:8080/api/v1/users/lookup?[redacted])",
            ),
            ("user a%40b.com", "user [user@host]"),
            (
                "dns lookup prod.example.com:22: failed",
                "dns lookup [host]:22: failed",
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(scrub(input), expected, "input: {input}");
        }
    }

    #[test]
    fn scrub_keeps_ordinary_text() {
        let text = "app_lib::db::open failed at src/db.rs:42:5 and logging.ts:21 in v0.0.11 after 12:30:05";
        assert_eq!(scrub(text), text);
    }

    #[test]
    fn scrub_redacts_hidden_values_as_whole_words() {
        hide("bare-prod-db");
        hide("deploy-user");
        hide("pi"); // too short to hide safely
        assert_eq!(
            scrub("failed to connect to bare-prod-db as deploy-user on pi"),
            "failed to connect to [redacted] as [redacted] on pi"
        );
        assert_eq!(scrub("bare-prod-dbx"), "bare-prod-dbx");
    }

    #[test]
    fn hide_record_hides_host_fields_only() {
        hide_record(
            r#"{"address":"rec-host.internal","username":"rec-user","destination_host":"fwd-target","name":"Production"}"#,
        );
        hide_record("not json rec-other");
        assert_eq!(
            scrub("rec-host.internal rec-user fwd-target Production rec-other"),
            "[redacted] [redacted] [redacted] Production rec-other"
        );
    }

    #[test]
    fn default_names_stay_readable() {
        hide("root");
        hide("localhost");
        hide("Ubuntu");
        assert_eq!(
            scrub("root cause on localhost running ubuntu"),
            "root cause on localhost running ubuntu"
        );
    }

    #[test]
    fn hidden_values_do_not_shield_secrets() {
        hide("apitoken");
        hide("mail.hidden-corp.com");
        assert_eq!(scrub("apitoken=abc123"), "[redacted]=[redacted]");
        assert_eq!(scrub("from ops@mail.hidden-corp.com"), "from [user@host]");
    }

    #[test]
    fn hidden_values_match_at_any_edge() {
        hide("_svc_");
        hide("-edge-");
        hide("fqdn.hidden.example.");
        hide("éé"); // 2 characters, 4 bytes: too short
        assert_eq!(
            scrub("as _svc_ via -edge- to fqdn.hidden.example. or fqdn.hidden.example.:22 éé"),
            "as [redacted] via [redacted] to [redacted]. or [host]:22 éé"
        );
        assert_eq!(scrub("dns other.example.org.:22"), "dns [host]:22");
        assert_eq!(scrub("dns ops_host.example.com:22"), "dns [host]:22");
        assert_eq!(scrub("at src/my_file.rs:12"), "at src/my_file.rs:12");
    }

    #[test]
    fn export_redacts_hidden_values_logged_before_hiding() {
        let dir = std::env::temp_dir().join(format!("shetu-log-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("shetu.log"),
            "connect to late-hidden-host failed\n",
        )
        .unwrap();
        hide("late-hidden-host");
        let out = dir.join("out.txt");
        export_logs_in(&dir, &out, "header").unwrap();
        let text = std::fs::read_to_string(&out).unwrap();
        assert!(text.contains("connect to [redacted] failed"), "{text}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn crash_marker_round_trip() {
        let dir = std::env::temp_dir().join(format!("shetu-log-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!take_crash_marker_in(&dir));
        write_crash_marker_in(&dir);
        assert!(take_crash_marker_in(&dir));
        assert!(!take_crash_marker_in(&dir), "marker is consumed once read");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn export_concatenates_logs_oldest_first() {
        let dir = std::env::temp_dir().join(format!("shetu-log-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("shetu.log"), "new\n").unwrap();
        std::fs::write(dir.join("shetu_2026-11-01_10-00-00.log"), "old\n").unwrap();
        std::fs::write(dir.join("unrelated.txt"), "skip\n").unwrap();
        let out = dir.join("out.txt");
        export_logs_in(&dir, &out, "header").unwrap();
        let text = std::fs::read_to_string(&out).unwrap();
        assert!(text.starts_with("header"));
        assert!(text.find("old").unwrap() < text.find("new").unwrap());
        assert!(!text.contains("skip"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn export_onto_a_source_log_keeps_its_contents() {
        let dir = std::env::temp_dir().join(format!("shetu-log-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let active = dir.join("shetu.log");
        std::fs::write(&active, "new\n").unwrap();
        export_logs_in(&dir, &active, "header").unwrap();
        assert!(std::fs::read_to_string(&active).unwrap().contains("new"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
