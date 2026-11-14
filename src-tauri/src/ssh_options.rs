use std::sync::RwLock;
use std::time::Duration;

#[derive(Clone, Debug, PartialEq)]
pub struct SshDefaults {
    pub keepalive_secs: u32,
    pub connect_timeout_secs: u32,
    pub term: String,
}

impl Default for SshDefaults {
    fn default() -> Self {
        Self { keepalive_secs: 30, connect_timeout_secs: 10, term: "xterm-256color".into() }
    }
}

static DEFAULTS: RwLock<Option<SshDefaults>> = RwLock::new(None);

pub fn defaults() -> SshDefaults {
    DEFAULTS.read().ok().and_then(|d| d.clone()).unwrap_or_default()
}

pub fn clamp_keepalive(secs: i64) -> u32 {
    if secs <= 0 { 0 } else { secs.clamp(5, 600) as u32 }
}

pub fn clamp_connect_timeout(secs: i64) -> u32 {
    secs.clamp(5, 60) as u32
}

pub fn normalize_term(term: &str) -> String {
    match term {
        "xterm-256color" | "xterm" | "vt100" => term.to_string(),
        _ => "xterm-256color".to_string(),
    }
}

pub fn client_config(defaults: &SshDefaults, host_keepalive: Option<u32>) -> russh::client::Config {
    let secs = host_keepalive.unwrap_or(defaults.keepalive_secs);
    let mut config = russh::client::Config::default();
    if secs > 0 {
        config.keepalive_interval = Some(Duration::from_secs(secs as u64));
        config.keepalive_max = 3;
    } else {
        config.keepalive_interval = None;
    }
    config
}

pub fn connect_timeout(defaults: &SshDefaults) -> Duration {
    Duration::from_secs(defaults.connect_timeout_secs as u64)
}

#[tauri::command]
pub fn set_ssh_defaults(keepalive_secs: i64, connect_timeout_secs: i64, term: String) -> Result<(), String> {
    let new = SshDefaults {
        keepalive_secs: clamp_keepalive(keepalive_secs),
        connect_timeout_secs: clamp_connect_timeout(connect_timeout_secs),
        term: normalize_term(&term),
    };
    *DEFAULTS.write().map_err(|e| e.to_string())? = Some(new);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test] fn defaults_match_spec() {
        let d = SshDefaults::default();
        assert_eq!((d.keepalive_secs, d.connect_timeout_secs, d.term.as_str()), (30, 10, "xterm-256color"));
    }
    #[test] fn clamps_out_of_range_keepalive() {
        assert_eq!([clamp_keepalive(0), clamp_keepalive(-5), clamp_keepalive(3), clamp_keepalive(45), clamp_keepalive(99_999)], [0, 0, 5, 45, 600]);
    }
    #[test] fn clamps_connect_timeout() {
        assert_eq!([clamp_connect_timeout(1), clamp_connect_timeout(20), clamp_connect_timeout(600)], [5, 20, 60]);
    }
    #[test] fn unknown_term_falls_back() {
        assert_eq!(normalize_term("vt100"), "vt100");
        assert_eq!(normalize_term("evil\nterm"), "xterm-256color");
    }
    #[test] fn client_config_uses_host_override_then_default() {
        let d = SshDefaults::default();
        let c = client_config(&d, None);
        assert_eq!((c.keepalive_interval, c.keepalive_max), (Some(Duration::from_secs(30)), 3));
        assert_eq!(client_config(&d, Some(0)).keepalive_interval, None);
        assert_eq!(client_config(&d, Some(120)).keepalive_interval, Some(Duration::from_secs(120)));
        let off = SshDefaults { keepalive_secs: 0, ..d };
        assert_eq!(client_config(&off, None).keepalive_interval, None);
    }
}
