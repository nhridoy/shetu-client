//! SSH user authentication: host key, agent keys, password, then keyboard-interactive.

use russh::client::KeyboardInteractiveAuthResponse as Kbd;
use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::{client::AuthResult, MethodKind, MethodSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

pub(crate) const NON_INTERACTIVE: &str =
    "This server needs an interactive login (2FA). Connect in a terminal instead.";
pub(crate) const CANCELLED: &str = "Login cancelled";
const AGENT_CAP_WITH_PASSWORD: usize = 3;

/// One keyboard-interactive round; each prompt is `(text, echo)`.
pub(crate) struct AuthPromptRequest {
    pub name: String,
    pub instructions: String,
    pub prompts: Vec<(String, bool)>,
}

/// Asks the user; `None` means cancelled.
pub(crate) type Prompter = Arc<
    dyn Fn(AuthPromptRequest) -> Pin<Box<dyn Future<Output = Option<Vec<String>>> + Send>>
        + Send
        + Sync,
>;

pub(crate) struct LoginContext<'a, A: AgentStream + Unpin> {
    pub agent: Option<&'a mut AgentClient<A>>,
    /// `None` = non-interactive.
    pub prompter: Option<Prompter>,
}

/// True on success; on failure remembers which methods the server still allows.
fn record(result: AuthResult, allowed: &mut Option<MethodSet>) -> bool {
    match result {
        AuthResult::Success => true,
        AuthResult::Failure { remaining_methods, .. } => {
            *allowed = Some(remaining_methods);
            false
        }
    }
}

pub(crate) async fn login<H, A>(
    session: &mut russh::client::Handle<H>,
    config: &crate::ssh::SshConfig,
    ctx: LoginContext<'_, A>,
) -> Result<(), String>
where
    H: russh::client::Handler,
    A: AgentStream + Send + Unpin + 'static,
{
    let mut key_error = None;
    let result = try_login(session, config, ctx, &mut key_error).await;
    match (result, key_error) {
        (Err(e), Some(key)) if e != CANCELLED => Err(format!("{key}; then: {e}")),
        (result, _) => result,
    }
}

async fn try_login<H, A>(
    session: &mut russh::client::Handle<H>,
    config: &crate::ssh::SshConfig,
    ctx: LoginContext<'_, A>,
    key_error: &mut Option<String>,
) -> Result<(), String>
where
    H: russh::client::Handler,
    A: AgentStream + Send + Unpin + 'static,
{
    let user = &config.username;
    // Methods the server still allows; unknown until the first failure lists them.
    let mut allowed: Option<MethodSet> = None;
    let allows = |allowed: &Option<MethodSet>, m: MethodKind| allowed.as_ref().is_none_or(|s| s.contains(&m));
    let mut last_error = "no authentication method succeeded".to_string();

    // No explicit credentials — send NONE auth request (servers like telehack.com accept it).
    if config.private_key.is_none() && config.password.is_none() {
        let auth = session.authenticate_none(user.clone()).await.map_err(|e| format!("none auth: {e}"))?;
        if record(auth, &mut allowed) {
            return Ok(());
        }
        last_error = "authentication required — add a password or SSH key".to_string();
    }

    if let Some(pem) = config.private_key.as_deref() {
        match russh::keys::decode_secret_key(pem, config.passphrase.as_deref()) {
            Ok(key) => {
                let key = russh::keys::key::PrivateKeyWithHashAlg::new(
                    Arc::new(key),
                    Some(russh::keys::HashAlg::Sha256),
                );
                let auth = session
                    .authenticate_publickey(user.clone(), key)
                    .await
                    .map_err(|e| format!("publickey auth: {e}"))?;
                if record(auth, &mut allowed) {
                    return Ok(());
                }
            }
            Err(e) => *key_error = Some(format!("decode private key: {e}")),
        }
    }

    if let Some(agent) = ctx.agent {
        if allows(&allowed, MethodKind::PublicKey) {
            let cap = if config.password.is_some() { AGENT_CAP_WITH_PASSWORD } else { usize::MAX };
            // Agent unreachable or erroring ends this step silently.
            let identities = agent.request_identities().await.unwrap_or_default();
            for identity in identities.into_iter().take(cap) {
                if !allows(&allowed, MethodKind::PublicKey) {
                    break;
                }
                let key = identity.public_key().into_owned();
                let hash = key.algorithm().is_rsa().then_some(russh::keys::HashAlg::Sha256);
                match session.authenticate_publickey_with(user.clone(), key, hash, agent).await {
                    Ok(auth) => {
                        if record(auth, &mut allowed) {
                            return Ok(());
                        }
                    }
                    Err(_) => break,
                }
            }
        }
    }

    let mut password_rejected = false;
    if let Some(password) = config.password.as_ref() {
        if allows(&allowed, MethodKind::Password) {
            let auth = session
                .authenticate_password(user.clone(), password.clone())
                .await
                .map_err(|e| format!("password auth: {e}"))?;
            if record(auth, &mut allowed) {
                return Ok(());
            }
            password_rejected = true;
            last_error = "authentication rejected".to_string();
        }
    }

    // Non-interactive with a rejected password: nothing could answer, keep today's error.
    if !allows(&allowed, MethodKind::KeyboardInteractive) || (password_rejected && ctx.prompter.is_none()) {
        return Err(last_error);
    }
    let kbd_err = |e: russh::Error| format!("keyboard-interactive auth: {e}");
    let mut auto_answer = config.password.clone().filter(|_| !password_rejected);
    let mut reply = session
        .authenticate_keyboard_interactive_start(user.clone(), None)
        .await
        .map_err(kbd_err)?;
    loop {
        let (name, instructions, prompts) = match reply {
            Kbd::Success => return Ok(()),
            Kbd::Failure { .. } => return Err("authentication rejected".to_string()),
            Kbd::InfoRequest { name, instructions, prompts } => (name, instructions, prompts),
        };
        let answers = if prompts.is_empty() {
            Vec::new()
        } else if let (1, false, Some(_)) = (prompts.len(), prompts[0].echo, &auto_answer) {
            vec![auto_answer.take().unwrap_or_default()]
        } else if let Some(prompter) = &ctx.prompter {
            let prompts = prompts.into_iter().map(|p| (p.prompt, p.echo)).collect();
            prompter(AuthPromptRequest { name, instructions, prompts }).await.ok_or(CANCELLED)?
        } else {
            return Err(NON_INTERACTIVE.to_string());
        };
        reply = session.authenticate_keyboard_interactive_respond(answers).await.map_err(kbd_err)?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::SshConfig;
    use russh::keys::agent::client::{AgentClient, AgentStream};
    use russh::keys::ssh_key::{Algorithm, LineEnding, PrivateKey, PublicKey};
    use russh::{MethodKind, MethodSet};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    type Agent = AgentClient<Box<dyn AgentStream + Send + Unpin>>;

    fn random_key() -> PrivateKey {
        PrivateKey::random(&mut rand10::rng(), Algorithm::Ed25519).unwrap()
    }

    fn fp(key: &PublicKey) -> String {
        format!("pk:{}", key.fingerprint(Default::default()))
    }

    /// Test server: accepts `keys`, `password` and one keyboard-interactive round of `kbd`
    /// (prompt, expected answer) pairs; logs every attempt it sees.
    #[derive(Clone, Default)]
    struct Srv {
        keys: Vec<PublicKey>,
        password: Option<&'static str>,
        kbd: Vec<(&'static str, &'static str)>,
        methods: Option<MethodSet>,
        log: Arc<Mutex<Vec<String>>>,
    }

    impl russh::server::Handler for Srv {
        type Error = russh::Error;
        async fn auth_publickey(
            &mut self,
            _: &str,
            key: &PublicKey,
        ) -> Result<russh::server::Auth, Self::Error> {
            self.log.lock().unwrap().push(fp(key));
            let ok = self.keys.iter().any(|k| k.key_data() == key.key_data());
            Ok(if ok { russh::server::Auth::Accept } else { russh::server::Auth::reject() })
        }
        async fn auth_password(
            &mut self,
            _: &str,
            password: &str,
        ) -> Result<russh::server::Auth, Self::Error> {
            self.log.lock().unwrap().push("password".into());
            Ok(if self.password == Some(password) {
                russh::server::Auth::Accept
            } else {
                russh::server::Auth::reject()
            })
        }
        async fn auth_keyboard_interactive<'a>(
            &'a mut self,
            _: &str,
            _: &str,
            response: Option<russh::server::Response<'a>>,
        ) -> Result<russh::server::Auth, Self::Error> {
            if self.kbd.is_empty() {
                return Ok(russh::server::Auth::reject());
            }
            let Some(response) = response else {
                self.log.lock().unwrap().push("kbdint".into());
                let prompts: Vec<_> = self.kbd.iter().map(|(p, _)| ((*p).into(), false)).collect();
                return Ok(russh::server::Auth::Partial {
                    name: "".into(),
                    instructions: "".into(),
                    prompts: prompts.into(),
                });
            };
            let answers: Vec<Vec<u8>> = response.map(|b| b.to_vec()).collect();
            let expected: Vec<Vec<u8>> = self.kbd.iter().map(|(_, a)| a.as_bytes().to_vec()).collect();
            Ok(if answers == expected { russh::server::Auth::Accept } else { russh::server::Auth::reject() })
        }
    }

    struct Client;
    impl russh::client::Handler for Client {
        type Error = russh::Error;
        async fn check_server_key(&mut self, _: &PublicKey) -> Result<bool, Self::Error> {
            Ok(true)
        }
    }

    fn config(key: Option<String>, password: Option<&str>) -> SshConfig {
        SshConfig {
            host: "test".into(),
            port: 22,
            username: "user".into(),
            private_key: key,
            password: password.map(String::from),
            ..Default::default()
        }
    }

    fn pem(key: &PrivateKey) -> String {
        key.to_openssh(LineEnding::LF).unwrap().to_string()
    }

    async fn run(
        srv: Srv,
        config: SshConfig,
        agent: Option<&mut Agent>,
        prompter: Option<Prompter>,
    ) -> Result<(), String> {
        let (server_io, client_io) = tokio::io::duplex(1 << 16);
        let mut server_config = russh::server::Config::default();
        server_config.keys.push(random_key());
        server_config.auth_rejection_time = std::time::Duration::ZERO;
        server_config.auth_rejection_time_initial = Some(std::time::Duration::ZERO);
        if let Some(methods) = srv.methods.clone() {
            server_config.methods = methods;
        }
        tokio::spawn(async move {
            if let Ok(running) = russh::server::run_stream(Arc::new(server_config), server_io, srv).await {
                let _ = running.await;
            }
        });
        let mut session =
            russh::client::connect_stream(Arc::new(russh::client::Config::default()), client_io, Client)
                .await
                .unwrap();
        login(&mut session, &config, LoginContext { agent, prompter }).await
    }

    /// In-process agent holding `keys`.
    async fn agent_with(keys: &[PrivateKey]) -> Agent {
        let (server_io, client_io) = tokio::io::duplex(1 << 16);
        #[derive(Clone)]
        struct Allow;
        impl russh::keys::agent::server::Agent for Allow {}
        tokio::spawn(russh::keys::agent::server::serve(
            futures::stream::iter(vec![Ok::<_, std::io::Error>(server_io)]),
            Allow,
        ));
        let mut agent = AgentClient::connect(client_io).dynamic();
        for key in keys {
            agent.add_identity(key, &[]).await.unwrap();
        }
        agent
    }

    fn count(log: &Arc<Mutex<Vec<String>>>, entry: &str) -> usize {
        log.lock().unwrap().iter().filter(|e| *e == entry).count()
    }

    fn methods(kinds: &[MethodKind]) -> Option<MethodSet> {
        Some(MethodSet::from(kinds))
    }

    #[tokio::test]
    async fn key_host_skips_agent_on_success() {
        let host_key = random_key();
        let agent_keys = [random_key(), random_key()];
        let mut agent = agent_with(&agent_keys).await;
        let srv = Srv { keys: vec![host_key.public_key().clone()], ..Default::default() };
        let log = srv.log.clone();
        run(srv, config(Some(pem(&host_key)), None), Some(&mut agent), None).await.unwrap();
        assert_eq!(*log.lock().unwrap(), vec![fp(host_key.public_key())]);
    }

    #[tokio::test]
    async fn password_host_unchanged_without_agent() {
        let srv = Srv { password: Some("pw"), ..Default::default() };
        let log = srv.log.clone();
        run(srv, config(None, Some("pw")), None, None).await.unwrap();
        assert_eq!(*log.lock().unwrap(), vec!["password".to_string()]);
    }

    #[tokio::test]
    async fn agent_keys_tried_after_host_key() {
        let host_key = random_key();
        let agent_keys = [random_key(), random_key()];
        let mut agent = agent_with(&agent_keys).await;
        let srv = Srv { keys: vec![agent_keys[1].public_key().clone()], ..Default::default() };
        let log = srv.log.clone();
        run(srv, config(Some(pem(&host_key)), None), Some(&mut agent), None).await.unwrap();
        let log = log.lock().unwrap().clone();
        assert_eq!(log.first(), Some(&fp(host_key.public_key())));
        assert_eq!(log.last(), Some(&fp(agent_keys[1].public_key())));
    }

    #[tokio::test]
    async fn agent_capped_at_three_when_password_saved() {
        let agent_keys: Vec<_> = (0..5).map(|_| random_key()).collect();
        let mut agent = agent_with(&agent_keys).await;
        let srv = Srv { password: Some("pw"), ..Default::default() };
        let log = srv.log.clone();
        run(srv, config(None, Some("pw")), Some(&mut agent), None).await.unwrap();
        let log = log.lock().unwrap().clone();
        let agent_attempts = log.iter().take_while(|e| *e != "password").count();
        assert_eq!(agent_attempts, 3, "{log:?}");
        assert_eq!(log.last().map(String::as_str), Some("password"));
    }

    #[tokio::test]
    async fn kbdint_auto_answers_when_password_method_absent() {
        let srv = Srv {
            kbd: vec![("Password: ", "pw")],
            methods: methods(&[MethodKind::PublicKey, MethodKind::KeyboardInteractive]),
            ..Default::default()
        };
        let log = srv.log.clone();
        run(srv, config(Some(pem(&random_key())), Some("pw")), None, None).await.unwrap();
        assert_eq!(count(&log, "password"), 0);
        assert_eq!(count(&log, "kbdint"), 1);
    }

    #[tokio::test]
    async fn kbdint_no_auto_answer_after_rejected_password() {
        let srv = Srv { kbd: vec![("Code: ", "123456")], ..Default::default() };
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let prompter: Prompter = Arc::new(move |request: AuthPromptRequest| {
            seen.fetch_add(1, Ordering::SeqCst);
            assert_eq!(request.prompts, vec![("Code: ".to_string(), false)]);
            Box::pin(async { Some(vec!["123456".to_string()]) })
        });
        run(srv, config(None, Some("pw")), None, Some(prompter)).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn kbdint_non_interactive_fails_with_message() {
        let srv = Srv {
            kbd: vec![("Password: ", "pw"), ("Code: ", "1")],
            methods: methods(&[MethodKind::PublicKey, MethodKind::KeyboardInteractive]),
            ..Default::default()
        };
        let err = run(srv, config(Some(pem(&random_key())), Some("pw")), None, None).await.unwrap_err();
        assert!(
            err.contains("This server needs an interactive login (2FA). Connect in a terminal instead."),
            "{err}"
        );
    }

    #[tokio::test]
    async fn kbdint_cancel_is_login_cancelled() {
        let srv = Srv { kbd: vec![("Code: ", "1")], ..Default::default() };
        let prompter: Prompter = Arc::new(|_| Box::pin(async { None }));
        let err = run(srv, config(Some(pem(&random_key())), None), None, Some(prompter)).await.unwrap_err();
        assert_eq!(err, "Login cancelled");
    }

    #[tokio::test]
    async fn bad_key_falls_through_to_password() {
        let bad = Some("not a key".to_string());
        let srv = Srv { password: Some("pw"), ..Default::default() };
        run(srv, config(bad.clone(), Some("pw")), None, None).await.unwrap();

        let srv = Srv { password: Some("other"), ..Default::default() };
        let err = run(srv, config(bad, Some("pw")), None, None).await.unwrap_err();
        assert!(err.starts_with("decode private key"), "{err}");
        assert!(err.contains("; then: "), "{err}");
    }
}
