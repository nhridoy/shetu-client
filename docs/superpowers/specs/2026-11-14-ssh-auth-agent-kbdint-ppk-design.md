# SSH auth: agent, keyboard-interactive, PuTTY keys — design

Phase "SSH essentials", sub-project B of three (A: connection options, merged in PR #31 → B: auth →
C: credential reuse). Source: `docs/analysis/2026-11-14-termoso-gap-analysis.md` §3.A.

## Intent

Users coming from Termius, OpenSSH or PuTTY can't log in to some servers with Shetu today:
- keys that live in their SSH agent (ssh-agent, Pageant, 1Password, KeePassXC) are never used;
- servers that ask for a 2FA code or use PAM's interactive prompt fail outright;
- PuTTY `.ppk` keys are rejected at import.

Success: these users connect the way they do in their old client, with no extra setup for the
common cases.

## Goals

**1. SSH agent login (automatic, like OpenSSH — user's decision).**
- The login order is:
  1. the host's own key;
  2. **every key the agent offers, in agent order**;
  3. the host's password;
  4. keyboard-interactive.

  Each step is tried only if the step before it failed and the server still allows that method.
- **Agent key cap (user's decision):** when the host has a saved password, at most **3** agent keys
  are tried, so the server's `MaxAuthTries` limit (default 6) still leaves room for the password.
  Hosts without a saved password try every agent key.
- A host with no saved key or password also tries the agent before giving up. Today it sends a
  `none` request and stops. The `none` probe stays first, because passwordless servers accept it.
- Agent location:
  - Unix/macOS: `SSH_AUTH_SOCK`.
  - Windows: the OpenSSH agent pipe `\\.\pipe\openssh-ssh-agent`, then Pageant.
  - An optional **"SSH agent socket"** path in Settings → SSH overrides this, for 1Password,
    KeePassXC and agents launched outside the desktop session. Empty means use the system default.
  - No agent reachable → that step is skipped silently. An agent error never fails the connect on
    its own.
- **Background checks never touch the agent:** ping and the OS probe are the connections whose
  handler has `auto_accept = true`. The reason is that agents such as 1Password show a confirmation
  popup per signature. Terminal, SFTP and port forwards do use the agent.

**2. Agent forwarding (per host, off by default).**
- The host form's Advanced section gets the toggle **"Forward SSH agent"**, with the help text
  "Lets this server use your local SSH keys while you're connected. Anyone with root on the server
  can use them too. Only enable for servers you trust."
- It is stored in the encrypted host payload as `forwardAgent: true | false`; missing means off.
  Older clients keep the field through the existing payload merge.
- It applies only to interactive terminal sessions on the target host, not to the jump host, SFTP
  or forwards. Shetu requests `auth-agent-req@openssh.com` on the shell channel. When the server
  opens an agent channel, Shetu bridges it to a **fresh** connection to the local agent.
- If the toggle is on but no agent is reachable, the terminal shows the one-line notice
  `[Agent forwarding unavailable: no SSH agent found]`. The session continues.

**3. Keyboard-interactive (server prompts).**
- Tried last, only if the server lists it.
- **Auto-answer:** if the host has a saved password and a round has exactly one prompt with echo
  off, Shetu answers it with the saved password once per connection. If the server asks again, the
  prompt goes to the user.
- **Otherwise the prompts go to the user:**
  - Rust emits one `ssh-auth-prompt` event with
    `{ id, host, port, username, name, instructions, prompts: [{ text, echo }] }`.
  - An app-wide **AuthPromptDialog**, mounted next to HostKeyDialog, shows the server's name and
    instructions. Each prompt is an input, masked when `echo` is false.
  - The dialog has **Continue** and **Cancel** buttons and answers with
    `answer_auth_prompt(id, responses | null)`.
  - Cancel, closing the dialog, or no answer within **5 minutes** aborts the login with
    "Login cancelled".
  - Further rounds open the dialog again, for example a password followed by a code.
- **Only user-started connections prompt:** the terminal and SFTP, whose handler is interactive
  (`!auto_accept && !require_known_host`, the same rule host-key prompts use). Port forwards, ping
  and the probe fail keyboard-interactive with "This server needs an interactive login (2FA).
  Connect in a terminal instead.", unless auto-answer covers it.
- The connect timeout pauses while a prompt is open, as it already does for host-key prompts.
- Prompt answers are never logged and never stored.

**4. PuTTY `.ppk` import.**
- The Keys → Import accepts PuTTY-User-Key-File v2 and v3, encrypted or not, by paste, file picker
  or drop.
- Rust converts the key to OpenSSH format at import:
  - with a passphrase, it is re-encrypted with the **same** passphrase, so it behaves like an
    imported encrypted OpenSSH key;
  - without one, it is stored unencrypted, inside the encrypted vault like any other key.
- A wrong or missing passphrase on an encrypted `.ppk` gives "This PuTTY key is encrypted — enter
  its passphrase" or "Wrong passphrase", and nothing is saved.
- The file picker accepts `.ppk`. The format check (`looksLikePrivateKey`) recognises
  `PuTTY-User-Key-File-`.

## Non-goals

- TOTP auto-fill: it needs somewhere to store a TOTP secret, which comes with identities in
  sub-project C.
- "Agent-held key" entries in the Keys list (public half only, signing by the agent).
- Shetu acting as an agent for other tools.
- FIDO2 / `sk-*` keys, certificates, X11.
- Agent forwarding over jump hosts or SFTP.
- Exporting keys to `.ppk`.

## Anti-goals

- Agent popups or prompts from background checks (ping, OS probe).
- A dialog appearing for a connection the user didn't start (forward auto-start, sync).
- Logging or storing prompt answers, agent key material, or the decrypted `.ppk`.
- Agent forwarding on by default, or enabled on a host without the user seeing the warning.
- Breaking today's login for key and password hosts. The new steps only add fallbacks after the
  existing ones.

## Constraints

- Tauri v2 + React 19 client; russh 0.62.6, which already provides:
  - `keys::agent::client::AgentClient` with `connect_env`, `connect_uds`, `connect_named_pipe` and
    `connect_pageant`;
  - `Handle::authenticate_publickey_with`;
  - `authenticate_keyboard_interactive_start` / `_respond`;
  - `Channel::agent_forward`;
  - the `Handler::server_channel_open_agent_forward` hook.
- ssh-key's `ppk` and `encryption` features are already enabled through russh, so
  `PrivateKey::from_ppk(text, passphrase)` and OpenSSH re-encryption are available without new
  dependencies.
- Login lives in `ssh::authenticate_over_stream`; every path goes through it (PR #31).
- The host-key prompt pattern to mirror:
  - `SshHandler::check_server_key`;
  - a pending map plus a oneshot;
  - the `ssh-host-key-prompt` event;
  - `accept_host_key`;
  - `HostKeyDialog.tsx` mounted in `App.tsx`;
  - `HostKeyPromptWatch`, which pauses the connect timeout.
- Settings follow the PR #31 pattern: a settings-store key pushed to Rust.
- Host options follow the PR #31 pattern: encrypted payload, `load_host_config`, and the HostForm
  Advanced section.
- Tests first: cargo tests for the login order, auto-answer, `.ppk` conversion and payload parsing;
  vitest for the dialog, the form toggle and import detection.
- No AI attribution anywhere.

## Approaches considered

- **Agent use:**
  - automatic like OpenSSH (**chosen by the user**);
  - explicit per host;
  - both.
- **Keyboard-interactive plumbing:**
  1. **Event + app-wide dialog**, mirroring the host-key prompt. **Chosen** (designer's call; the
     user handed over the how). It works for terminal and SFTP and reuses an existing pattern.
  2. The frontend drives login step by step. That would rewrite every connect path. Rejected.
  3. Prompts typed into the terminal like OpenSSH. SFTP has no terminal, and hiding secrets in
     xterm is fiddly. Rejected.
- **`.ppk`:** convert at import (chosen) rather than at every connect. The connect code stays
  untouched and the vault holds one format.

## Calls made after the builder check (designer's calls — flagged for review)

1. **Port forwards use the agent.** Forwards only start when the user starts them today; auto-start
   is a later phase. Revisit the popup question when auto-start lands.
2. **Jump hosts:**
   - Terminal and SFTP bastion hops use the agent and keyboard-interactive like the target, because
     their handlers are interactive.
   - The prompt dialog shows the hop's own `host:port`, so the user sees which server is asking.
   - Ping of a route whose bastion only logs in through the agent shows unreachable. Such hosts
     can't log in at all today, so this is not a regression.
3. **Saved-key failures fall through.** A key that fails to decode or has a wrong passphrase no
   longer aborts the login; the agent, password and keyboard-interactive steps still run. If
   everything fails, the error starts with the key problem, for example
   `decode private key: …; then: authentication rejected`.
4. **Allowed methods:** read from `remaining_methods` on each failure. No new `none` probe for hosts
   that have credentials, so today's round trips are unchanged.
5. **`.ppk` import API:**
   - A new Rust command `convert_ppk(text, passphrase) -> String` returns the OpenSSH text,
     re-encrypted with the passphrase when one is given.
   - Distinct errors `PPK_ENCRYPTED` and `PPK_BAD_PASSPHRASE` drive the two modal messages.
   - The modal then saves the converted text through the existing import path. The passphrase is
     stored exactly as for an imported encrypted OpenSSH key.
6. **No auto-answer after a rejected password.** If the password step ran and the server rejected
   it, keyboard-interactive never sends the same password again. It goes straight to the dialog, or
   fails on non-interactive paths.
7. **Agent channels only when asked.** The connection handler carries a `forward_agent` flag, set
   only for the terminal session of a host with the toggle on. Agent channels the server opens
   otherwise are refused.

## Left to the builder

- Exact dialog layout and copy within the HostKeyDialog style.
- How the agent client is shared within one login, provided each forwarded agent channel opens its
  own fresh local connection.
- Whether the Settings agent-path field validates that the path exists. Recommended: no, just try
  it at connect.
