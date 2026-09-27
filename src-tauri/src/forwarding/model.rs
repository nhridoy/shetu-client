use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ForwardMode {
    Local,
    Remote,
    Dynamic,
}

impl ForwardMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Remote => "remote",
            Self::Dynamic => "dynamic",
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "local" => Ok(Self::Local),
            "remote" => Ok(Self::Remote),
            "dynamic" => Ok(Self::Dynamic),
            _ => Err(format!("Unknown forward mode: {value}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardInput {
    pub host_id: String,
    pub mode: ForwardMode,
    pub name: String,
    pub local_port: Option<u16>,
    pub remote_bind_address: Option<String>,
    pub remote_port: Option<u16>,
    pub destination_host: Option<String>,
    pub destination_port: Option<u16>,
}

impl ForwardInput {
    pub fn local(
        host_id: &str,
        name: &str,
        local_port: u16,
        destination_host: &str,
        destination_port: u16,
    ) -> Self {
        Self {
            host_id: host_id.into(),
            mode: ForwardMode::Local,
            name: name.into(),
            local_port: Some(local_port),
            remote_bind_address: None,
            remote_port: None,
            destination_host: Some(destination_host.into()),
            destination_port: Some(destination_port),
        }
    }

    pub fn dynamic(host_id: &str, name: &str, local_port: u16) -> Self {
        Self {
            host_id: host_id.into(),
            mode: ForwardMode::Dynamic,
            name: name.into(),
            local_port: Some(local_port),
            remote_bind_address: None,
            remote_port: None,
            destination_host: None,
            destination_port: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardDefinition {
    pub id: String,
    pub host_id: String,
    pub mode: ForwardMode,
    pub name: String,
    pub local_port: Option<u16>,
    pub remote_bind_address: Option<String>,
    pub remote_port: Option<u16>,
    pub destination_host: Option<String>,
    pub destination_port: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", content = "error", rename_all = "snake_case")]
pub enum ForwardStatus {
    Stopped,
    Starting,
    Active,
    Failed(String),
}

fn bounded_text(value: &str, label: &str, max: usize) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > max {
        return Err(format!("{label} must be nonempty and at most {max} bytes"));
    }
    Ok(())
}

fn port(value: Option<u16>, label: &str) -> Result<(), String> {
    if !matches!(value, Some(1..=u16::MAX)) {
        return Err(format!("{label} must be between 1 and 65535"));
    }
    Ok(())
}

pub fn validate(input: &ForwardInput) -> Result<(), String> {
    bounded_text(&input.host_id, "Host ID", 255)?;
    bounded_text(&input.name, "Name", 128)?;
    match input.mode {
        ForwardMode::Local => {
            port(input.local_port, "Local port")?;
            bounded_text(
                input.destination_host.as_deref().unwrap_or(""),
                "Destination host",
                255,
            )?;
            port(input.destination_port, "Destination port")?;
            if input.remote_bind_address.is_some() || input.remote_port.is_some() {
                return Err("Local forward cannot specify remote bind fields".into());
            }
        }
        ForwardMode::Remote => {
            let bind_address = input.remote_bind_address.as_deref().unwrap_or("");
            if !matches!(bind_address, "127.0.0.1" | "0.0.0.0") {
                return Err("Remote bind address must be 127.0.0.1 or 0.0.0.0".into());
            }
            port(input.remote_port, "Remote port")?;
            bounded_text(
                input.destination_host.as_deref().unwrap_or(""),
                "Destination host",
                255,
            )?;
            port(input.destination_port, "Destination port")?;
            if input.local_port.is_some() {
                return Err("Remote forward cannot specify a local port".into());
            }
        }
        ForwardMode::Dynamic => {
            port(input.local_port, "Local port")?;
            if input.remote_bind_address.is_some()
                || input.remote_port.is_some()
                || input.destination_host.is_some()
                || input.destination_port.is_some()
            {
                return Err("Dynamic forward cannot specify remote or destination fields".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_each_modes_required_fields() {
        assert!(validate(&ForwardInput::local("h1", "web", 8080, "localhost", 80)).is_ok());
        assert!(validate(&ForwardInput {
            host_id: "h1".into(),
            mode: ForwardMode::Remote,
            name: "remote".into(),
            local_port: None,
            remote_bind_address: Some("127.0.0.1".into()),
            remote_port: Some(8080),
            destination_host: Some("localhost".into()),
            destination_port: Some(80),
        })
        .is_ok());
        assert!(validate(&ForwardInput::dynamic("h1", "socks", 1080)).is_ok());
    }

    #[test]
    fn rejects_missing_fields_and_zero_ports() {
        assert!(validate(&ForwardInput::dynamic("h1", "socks", 0)).is_err());
        assert!(validate(&ForwardInput::local("h1", "web", 8080, "localhost", 0)).is_err());
        let mut local = ForwardInput::local("h1", "web", 8080, "localhost", 80);
        local.destination_host = None;
        assert!(validate(&local).is_err());
        local.destination_host = Some(" ".into());
        assert!(validate(&local).is_err());
        local.destination_host = Some("x".repeat(256));
        assert!(validate(&local).is_err());
        let mut remote = ForwardInput {
            host_id: "h1".into(),
            mode: ForwardMode::Remote,
            name: "remote".into(),
            local_port: None,
            remote_bind_address: Some("127.0.0.1".into()),
            remote_port: Some(8080),
            destination_host: Some("localhost".into()),
            destination_port: Some(80),
        };
        remote.remote_port = None;
        assert!(validate(&remote).is_err());
        remote.remote_port = Some(0);
        assert!(validate(&remote).is_err());
        remote.remote_port = Some(8080);
        remote.remote_bind_address = Some("192.168.1.10".into());
        assert!(validate(&remote).is_err());
    }

    #[test]
    fn rejects_irrelevant_fields_and_blank_identity() {
        let mut dynamic = ForwardInput::dynamic("h1", "socks", 1080);
        dynamic.destination_port = Some(80);
        assert!(validate(&dynamic).is_err());
        dynamic.destination_port = None;
        dynamic.host_id = " ".into();
        assert!(validate(&dynamic).is_err());
        dynamic.host_id = "h1".into();
        dynamic.name = " ".into();
        assert!(validate(&dynamic).is_err());
    }
}
