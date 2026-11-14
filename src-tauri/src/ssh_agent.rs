//! Finds the local SSH agent: the Settings override, else the system default.

use russh::keys::agent::client::{AgentClient, AgentStream};
use std::time::Duration;

pub(crate) type Agent = AgentClient<Box<dyn AgentStream + Send + Unpin>>;

/// Bounds each attempt so a stuck socket cannot stall login.
async fn bounded<F>(attempt: F) -> Option<Agent>
where
    F: std::future::Future<Output = Result<Agent, russh::keys::Error>>,
{
    tokio::time::timeout(Duration::from_secs(2), attempt).await.ok()?.ok()
}

#[cfg(unix)]
pub(crate) async fn connect_agent(override_path: &str) -> Option<Agent> {
    let path = if override_path.is_empty() {
        std::env::var("SSH_AUTH_SOCK").ok().filter(|p| !p.is_empty())?
    } else {
        override_path.to_string()
    };
    bounded(async { Ok(AgentClient::connect_uds(path).await?.dynamic()) }).await
}

#[cfg(windows)]
pub(crate) async fn connect_agent(override_path: &str) -> Option<Agent> {
    // A non-empty override is a named-pipe path on Windows.
    let pipe = if override_path.is_empty() { r"\\.\pipe\openssh-ssh-agent" } else { override_path };
    if let Some(agent) = bounded(async { Ok(AgentClient::connect_named_pipe(pipe).await?.dynamic()) }).await {
        return Some(agent);
    }
    if !override_path.is_empty() {
        return None;
    }
    bounded(async { Ok(AgentClient::connect_pageant().await?.dynamic()) }).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unreachable_agent_path_is_skipped() {
        assert!(connect_agent("/nonexistent/agent.sock").await.is_none());
        let file = std::env::temp_dir().join(format!("shetu-notsock-{}", std::process::id()));
        std::fs::write(&file, b"x").unwrap();
        assert!(connect_agent(file.to_str().unwrap()).await.is_none());
        let _ = std::fs::remove_file(&file);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn override_path_connects() {
        use russh::keys::{Algorithm, PrivateKey};
        #[derive(Clone)]
        struct Allow;
        impl russh::keys::agent::server::Agent for Allow {}

        let sock = std::env::temp_dir().join(format!("shetu-agent-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&sock);
        let listener = tokio::net::UnixListener::bind(&sock).unwrap();
        let incoming = futures::stream::unfold(listener, |l| async move {
            let next = l.accept().await.map(|(s, _)| s);
            Some((next, l))
        });
        tokio::spawn(russh::keys::agent::server::serve(Box::pin(incoming), Allow));

        let mut agent = connect_agent(sock.to_str().unwrap()).await.expect("agent connects");
        let key = PrivateKey::random(&mut rand10::rng(), Algorithm::Ed25519).unwrap();
        agent.add_identity(&key, &[]).await.unwrap();
        let ids = agent.request_identities().await.unwrap();
        assert_eq!(ids.len(), 1);
        assert_eq!(ids[0].public_key().as_ref(), key.public_key());
        let _ = std::fs::remove_file(&sock);
    }
}
