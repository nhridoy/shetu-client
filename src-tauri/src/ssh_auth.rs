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
const KBD_MAX_ROUNDS: usize = 10;
const AGENT_LIST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

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

enum Step {
    Success,
    /// Accepted, but the server wants another method too.
    Partial,
    Rejected,
}

/// Classifies a result; on failure remembers which methods the server still allows.
fn record(result: AuthResult, allowed: &mut Option<MethodSet>) -> Step {
    match result {
        AuthResult::Success => Step::Success,
        AuthResult::Failure { remaining_methods, partial_success } => {
            *allowed = Some(remaining_methods);
            if partial_success { Step::Partial } else { Step::Rejected }
        }
    }
}

/// Agent signer that never wedges the session. russh's session task blocks until it gets a
/// signature, so on an agent refusal this sends a dummy one (the server answers failure)
/// and sets `refused` to end the agent step.
struct AgentSigner<'a, A: AgentStream + Unpin> {
    agent: &'a mut AgentClient<A>,
    refused: bool,
}

impl<A: AgentStream + Send + Unpin> russh::Signer for AgentSigner<'_, A> {
    type Error = russh::AgentAuthError;

    async fn auth_sign(
        &mut self,
        key: &russh::keys::agent::AgentIdentity,
        hash_alg: Option<russh::keys::HashAlg>,
        to_sign: Vec<u8>,
    ) -> Result<Vec<u8>, Self::Error> {
        match self.agent.sign_request(key, hash_alg, to_sign.clone()).await {
            Ok(signed) => Ok(signed),
            Err(_) => {
                self.refused = true;
                Ok(append_dummy_signature(to_sign, &key.public_key(), hash_alg))
            }
        }
    }
}

/// Appends a well-formed but invalid signature blob, as the agent client would append a real one.
fn append_dummy_signature(mut data: Vec<u8>, key: &russh::keys::PublicKey, hash_alg: Option<russh::keys::HashAlg>) -> Vec<u8> {
    use russh::keys::ssh_key::Algorithm;
    let algorithm = match key.algorithm() {
        Algorithm::Rsa { .. } => Algorithm::Rsa { hash: hash_alg },
        other => other,
    };
    let (sig, trailer): (&[u8], &[u8]) = match algorithm {
        // Two mpints (r = s = 1) so strict parsers accept the shape.
        Algorithm::Ecdsa { .. } => (&[0, 0, 0, 1, 1, 0, 0, 0, 1, 1], &[]),
        Algorithm::SkEcdsaSha2NistP256 => (&[0, 0, 0, 1, 1, 0, 0, 0, 1, 1], &[0; 5]),
        Algorithm::SkEd25519 => (&[0; 64], &[0; 5]),
        _ => (&[0; 64], &[]),
    };
    let name = algorithm.as_str().as_bytes();
    let put = |buf: &mut Vec<u8>, bytes: &[u8]| {
        buf.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        buf.extend_from_slice(bytes);
    };
    let mut blob = Vec::new();
    put(&mut blob, name);
    put(&mut blob, sig);
    blob.extend_from_slice(trailer);
    put(&mut data, &blob);
    data
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
        if let Step::Success = record(auth, &mut allowed) {
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
                if let Step::Success = record(auth, &mut allowed) {
                    return Ok(());
                }
            }
            Err(e) => *key_error = Some(format!("decode private key: {e}")),
        }
    }

    if let Some(agent) = ctx.agent {
        if allows(&allowed, MethodKind::PublicKey) {
            let cap = if config.password.is_some() { AGENT_CAP_WITH_PASSWORD } else { usize::MAX };
            // Agent unreachable, erroring or silent ends this step. Signing stays unlimited
            // because confirmation popups are legitimate.
            let identities = tokio::time::timeout(AGENT_LIST_TIMEOUT, agent.request_identities())
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_default();
            let mut signer = AgentSigner { agent, refused: false };
            for identity in identities.into_iter().take(cap) {
                if signer.refused || !allows(&allowed, MethodKind::PublicKey) {
                    break;
                }
                let key = identity.public_key().into_owned();
                let hash = key.algorithm().is_rsa().then_some(russh::keys::HashAlg::Sha256);
                match session.authenticate_publickey_with(user.clone(), key, hash, &mut signer).await {
                    Ok(auth) => {
                        if let Step::Success = record(auth, &mut allowed) {
                            return Ok(());
                        }
                    }
                    Err(_) => break,
                }
            }
        }
    }

    let (mut password_ran, mut password_rejected) = (false, false);
    if let Some(password) = config.password.as_ref() {
        if allows(&allowed, MethodKind::Password) {
            let auth = session
                .authenticate_password(user.clone(), password.clone())
                .await
                .map_err(|e| format!("password auth: {e}"))?;
            password_ran = true;
            match record(auth, &mut allowed) {
                Step::Success => return Ok(()),
                Step::Partial => {}
                Step::Rejected => {
                    password_rejected = true;
                    last_error = "authentication rejected".to_string();
                }
            }
        }
    }

    // Non-interactive with a rejected password: nothing could answer, keep today's error.
    if !allows(&allowed, MethodKind::KeyboardInteractive) || (password_rejected && ctx.prompter.is_none()) {
        return Err(last_error);
    }
    let kbd_err = |e: russh::Error| format!("keyboard-interactive auth: {e}");
    // Never resend the password once the password step ran (rejected or partial).
    let mut auto_answer = config.password.clone().filter(|_| !password_ran);
    // A second attempt happens only after a wrong auto-answer, with auto-answer gone.
    'attempt: loop {
        let mut auto_answered = false;
        let mut reply = session
            .authenticate_keyboard_interactive_start(user.clone(), None)
            .await
            .map_err(kbd_err)?;
        for _ in 0..KBD_MAX_ROUNDS {
            let (name, instructions, prompts) = match reply {
                Kbd::Success => return Ok(()),
                Kbd::Failure { remaining_methods, .. } => {
                    if auto_answered
                        && ctx.prompter.is_some()
                        && remaining_methods.contains(&MethodKind::KeyboardInteractive)
                    {
                        continue 'attempt;
                    }
                    return Err("authentication rejected".to_string());
                }
                Kbd::InfoRequest { name, instructions, prompts } => (name, instructions, prompts),
            };
            let answers = if prompts.is_empty() {
                Vec::new()
            } else if let (1, false, Some(_)) = (prompts.len(), prompts[0].echo, &auto_answer) {
                auto_answered = true;
                vec![auto_answer.take().unwrap_or_default()]
            } else if let Some(prompter) = &ctx.prompter {
                let prompts = prompts.into_iter().map(|p| (p.prompt, p.echo)).collect();
                prompter(AuthPromptRequest { name, instructions, prompts }).await.ok_or(CANCELLED)?
            } else {
                return Err(NON_INTERACTIVE.to_string());
            };
            reply = session.authenticate_keyboard_interactive_respond(answers).await.map_err(kbd_err)?;
        }
        return Err("authentication rejected".to_string());
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
        /// Correct password gets "partial success, continue with keyboard-interactive".
        password_partial: bool,
        /// Keyboard-interactive answers every round with another zero-prompt request.
        kbd_endless: bool,
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
            Ok(if self.password == Some(password) && self.password_partial {
                russh::server::Auth::Reject {
                    proceed_with_methods: Some(MethodSet::from(&[MethodKind::KeyboardInteractive][..])),
                    partial_success: true,
                }
            } else if self.password == Some(password) {
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
            if self.kbd_endless {
                self.log.lock().unwrap().push("kbdint".into());
                return Ok(russh::server::Auth::Partial {
                    name: "".into(),
                    instructions: "".into(),
                    prompts: Vec::new().into(),
                });
            }
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

    #[derive(Clone)]
    struct Allow;
    impl russh::keys::agent::server::Agent for Allow {}

    /// Agent that refuses every sign request, like a declined `ssh-add -c` confirm.
    #[derive(Clone)]
    struct RefuseSign;
    impl russh::keys::agent::server::Agent for RefuseSign {
        async fn confirm_request(&self, msg: russh::keys::agent::server::MessageType) -> bool {
            !matches!(msg, russh::keys::agent::server::MessageType::Sign)
        }
    }

    /// In-process agent holding `keys`.
    async fn agent_with(keys: &[PrivateKey]) -> Agent {
        agent_serving(keys, Allow).await
    }

    async fn agent_serving(keys: &[PrivateKey], behaviour: impl russh::keys::agent::server::Agent + Sync) -> Agent {
        let (server_io, client_io) = tokio::io::duplex(1 << 16);
        tokio::spawn(russh::keys::agent::server::serve(
            futures::stream::iter(vec![Ok::<_, std::io::Error>(server_io)]),
            behaviour,
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

    fn within<T>(f: impl std::future::Future<Output = T>) -> impl std::future::Future<Output = T> {
        async { tokio::time::timeout(std::time::Duration::from_secs(10), f).await.expect("login hung") }
    }

    #[tokio::test]
    async fn agent_sign_refusal_does_not_wedge_session() {
        let mut agent = agent_serving(&[random_key()], RefuseSign).await;
        let srv = Srv { password: Some("pw"), ..Default::default() };
        let log = srv.log.clone();
        within(run(srv, config(None, Some("pw")), Some(&mut agent), None)).await.unwrap();
        assert_eq!(count(&log, "password"), 1);
    }

    #[tokio::test]
    async fn silent_agent_is_skipped_after_timeout() {
        // The peer accepts the connection but never answers the identities request.
        let (_silent_peer, client_io) = tokio::io::duplex(1 << 16);
        let mut agent: Agent = AgentClient::connect(client_io).dynamic();
        let srv = Srv { password: Some("pw"), ..Default::default() };
        let log = srv.log.clone();
        within(run(srv, config(None, Some("pw")), Some(&mut agent), None)).await.unwrap();
        assert_eq!(count(&log, "password"), 1);
    }

    #[test]
    fn partial_success_is_not_a_rejection() {
        let mut allowed = None;
        let remaining = MethodSet::from(&[MethodKind::KeyboardInteractive][..]);
        let result = AuthResult::Failure { remaining_methods: remaining.clone(), partial_success: true };
        assert!(matches!(record(result, &mut allowed), Step::Partial));
        assert_eq!(allowed, Some(remaining));
        let result = AuthResult::Failure { remaining_methods: MethodSet::empty(), partial_success: false };
        assert!(matches!(record(result, &mut allowed), Step::Rejected));
        assert!(matches!(record(AuthResult::Success, &mut allowed), Step::Success));
    }

    // russh's test server clears partial_success on password replies (server/encrypted.rs ~771),
    // so only the remaining-methods half of a partial success reaches the client here.
    #[tokio::test]
    async fn password_then_two_factor_kbdint_with_prompter() {
        let srv = Srv {
            password: Some("pw"),
            password_partial: true,
            kbd: vec![("Password: ", "pw"), ("Code: ", "1")],
            ..Default::default()
        };
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let prompter: Prompter = Arc::new(move |_| {
            seen.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Some(vec!["pw".to_string(), "1".to_string()]) })
        });
        within(run(srv, config(None, Some("pw")), None, Some(prompter))).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn kbdint_rounds_are_capped() {
        let srv = Srv { kbd_endless: true, ..Default::default() };
        let log = srv.log.clone();
        let err = within(run(srv, config(Some(pem(&random_key())), None), None, None)).await.unwrap_err();
        assert_eq!(err, "authentication rejected");
        assert!(count(&log, "kbdint") <= KBD_MAX_ROUNDS + 1, "{:?}", log.lock().unwrap());
    }

    #[tokio::test]
    async fn stale_auto_answer_falls_back_to_prompter() {
        let srv = Srv {
            kbd: vec![("Password: ", "fresh")],
            methods: methods(&[MethodKind::PublicKey, MethodKind::KeyboardInteractive]),
            ..Default::default()
        };
        let log = srv.log.clone();
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let prompter: Prompter = Arc::new(move |_| {
            seen.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Some(vec!["fresh".to_string()]) })
        });
        within(run(srv, config(Some(pem(&random_key())), Some("stale")), None, Some(prompter)))
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(count(&log, "kbdint"), 2);
    }
}
