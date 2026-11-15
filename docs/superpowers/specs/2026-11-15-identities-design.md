# Identities (reusable saved logins with optional TOTP) — design

Phase "SSH essentials", sub-project C, part 2 (part 1, group credentials, merged in PR #33).
Source: `docs/analysis/2026-11-14-termoso-gap-analysis.md` §3.A "Identities".

## Intent

Many servers share one login. Today a user retypes the username and password, or picks a key, on
every host or group. An **identity** is a saved login, picked by name, that many hosts and groups
use. Changing it in one place updates them all. An identity can also hold a **TOTP secret**, so
Shetu fills a server's 2FA code automatically.

Success: create "deploy@prod" once, point hosts or groups at it, and they connect with its
username, password or key, and 2FA code. Editing the identity updates every host and group that
uses it.

## Goals

**What an identity holds (user's decision: including TOTP).**
- **Label** (required), stored in a plain `name` column so lists don't need decryption.
- **Encrypted data:** `username` (required), `password` (optional), `keyId` (optional, a key in
  the same vault) and `totpSecret` (optional, base32).
- At least one of password or key is expected. Neither is allowed: the identity then gives only the
  username, and Shetu asks for the rest at connect as today.

**How hosts and groups use it (user's decision: the identity replaces the login).**
- The Login method dropdown gains **"Identity"**, followed by a picker of identities in the current
  vault and **"+ New identity"**.
- With Identity chosen, the host's Username field is hidden. The identity supplies the username
  **and** the password, key and TOTP.
- Stored in the encrypted host or group data as `identityId`. The host row's plain `auth_type` is
  `"identity"`. The group payload's `authType` is `"identity"`.
- **Inheritance:** a host on "From group" whose nearest group with credentials uses an identity
  inherits that identity, all of it as one unit, like other group credentials. The username comes
  from the identity, so a host can't mix in its own username.
- **Placeholders/hints:**
  - Login line: "Identity '{label}' · {group}" when inherited, "Identity '{label}'" when chosen
    directly.
  - The host's username hint shows the identity's username.

**Managing identities (user's decision: Keychain tabs).**
- The Keys page becomes **Keychain** with tabs **Keys | Identities**.
- The Identities tab lists identities by label and username, with New, Edit and Delete.
- The identity form uses the app's existing modal form style, like the key modals. Fields:
  - **Label**;
  - **Username**;
  - **Password** (masked; leave empty to keep the stored one when editing);
  - **SSH key** picker (same vault);
  - **TOTP**: a secret field that accepts base32 or an `otpauth://totp/...` URI (the secret and its
    parameters are taken from it). It shows a live preview of the current code and the seconds
    left, so the user can check it against their phone.
- **"+ New identity"** in the host or group picker opens the same form. On save, the new identity is
  selected.

**Deleting (user's decision: warn, then fall back).**
- The confirm dialog says how many hosts and groups in the vault use it: "Used by 3 hosts and 1
  group. They'll ask for a login when connecting." Counting reads the encrypted host and group data
  in the current vault.
- After deletion, any host or group still pointing at it resolves as if no credentials were set:
  "Ask when connecting", or its group if the host inherits.

**TOTP auto-fill (Rust).**
- Codes are generated in Rust at prompt time: RFC 6238, HMAC-SHA1 by default (SHA256 and SHA512 if
  the otpauth URI says so), 6 digits by default (8 if specified), 30 s period by default.
- **When:** during keyboard-interactive login, if the effective credentials come from an identity
  with a TOTP secret, and a round has exactly one prompt whose text matches
  `/(verification|one[- ]?time|otp|token|authenticator|2fa|two[- ]factor|code)/i`. Shetu answers
  with the current code, once per connection. A rejected code makes later rounds go to the dialog.
- **Password auto-answer:** the existing rule still applies with the identity's password: a single
  non-echo prompt that isn't a code prompt.
- **Order in a password-plus-OTP chain:** a password prompt gets the password and a code prompt gets
  the code. Each auto-fill happens at most once per connection.
- **Secrets stay in Rust:** the secret and the codes never cross IPC (except the code preview in the
  identity form; see Rust below) and are never logged.

## Server (shetu-server PR, ships first)

- New model `Identity`, table `identities`. Columns follow `Snippet`: id, vault_id (cascade),
  revision, name, sort_order, data, deleted_at, created_at, updated_at, edited_at, device_id,
  operation_id. There are no plain description or tags columns.
- Register it everywhere the vault-scoped tables are listed:
  - the models list (AutoMigrate);
  - timestamps;
  - sync validation: optional plain fields none beyond `name`;
  - the sync handlers' table list;
  - team key rotation (`rotationTables` + its switch);
  - the account-deletion purge (`vaultScoped`).
- Tests follow the existing table tests: sync push/pull round trip, rotation re-encrypts, and purge
  removes identities.

## Client (shetu-client PR)

**Rust.**
- **Local DB:** `Table::Identities`, schema, column lists and sync (`db.rs`, `sync_db.rs`). TS
  `TableName` gains `"identities"`.
- **Resolution:** in `host_inherit::resolve` and `load_host_config`, `authType: "identity"` loads
  the identity row. It must be in the host's vault and not deleted; otherwise it is treated as unset
  (falls back). Its username, password and key fill the effective config, and `totp_secret` becomes
  a new `SshConfig.totp: Option<TotpParams>`.
- `inherited_host_defaults` adds `identityName` / `identityFrom` and `identityUsername`. It never
  returns the password or TOTP.
- `ssh_auth::login` adds the TOTP auto-fill step.
- **New module `totp.rs`:** otpauth URI parsing, base32 decode and code generation. Tests use the
  RFC 6238 vectors.
- **Command `totp_preview(secret_or_uri) -> { code, secondsLeft }`** for the identity form's
  preview. It takes the value being typed, so a secret the user is entering crosses IPC only from
  the form, which already holds it. Saved secrets are never sent to the frontend.
- **Crates:** `hmac` and `sha1` are already dependencies; move `sha1` from dev-dependencies to
  dependencies, and add `sha2` if needed (check the lockfile). Base32 decoding is a small local
  function, or `data-encoding` (already in the lockfile) as a direct dependency.

**Frontend.**
- **Store:** `identityStore` (list, create, update merge-safe through `runSerial`, delete,
  decrypt-on-demand), mirroring `keyStore` and `snippetStore`.
- **Keychain page** with tabs, an identity list and an identity modal form with the TOTP field and
  live preview.
- **Login method:** CredentialsFields gains "Identity" + picker + "+ New identity", for hosts and
  groups.
- **Host form:** hides Username while Identity is chosen.
- **Hints:** login line and username hint for identities.
- **Delete:** the confirm dialog counts usage.

## Non-goals

- QR-code scanning for TOTP.
- HOTP (counter-based) codes.
- Steam-style codes.
- TOTP on hosts without an identity.
- Identities across vaults.
- Certificates or FIDO keys in identities.
- An identity-level jump host or options. Identities carry only the login.

## Anti-goals

- A TOTP secret or code in logs, in the plain columns, or sent to the frontend for saved identities.
- A host silently using another vault's identity.
- Breaking existing hosts: hosts not on Identity behave exactly as before.
- Deleting an identity leaving hosts unable to connect without telling the user. The warning plus
  "Ask when connecting" fallback covers this.

## Constraints

- **Server:** Go + gin + GORM, the vault-scoped table pattern. On SQLite, foreign keys are off, so
  the purge must delete explicitly.
- **Client:** Tauri v2 + React 19. Reuse:
  - the `keys` table and keyStore patterns;
  - the PR #33 resolution chain (`host_inherit.rs`) and side-panel forms;
  - the `CredentialsFields` dropdown;
  - the `runSerial` store queue.
- **Order:** the server PR merges first. A client that syncs to an older server must not break: the
  identities table simply doesn't sync until the server supports it. Check how unknown tables are
  handled on push or pull, and degrade quietly.
- **Testing:** tests first (Go, cargo, vitest). No AI attribution.

## Approaches considered

1. **The identity reference lives in the encrypted host or group data** (**chosen**, designer's
   call). No host or group schema change on the server, and the link stays private.
   Alternative: a plain `identity_id` column on hosts, with server relationship validation. That
   adds migrations and leaks which hosts share a login.
2. **TOTP codes generated in Rust at prompt time** (**chosen**). The secret never crosses IPC.
   Alternative: the frontend generates codes. That exposes saved secrets to the webview.
3. **One identity form in a modal**, matching the key modals on the Keychain page, rather than the
   side panel. The Keychain page has no host list to push.

## Calls made after the builder check (designer's calls — flagged for review)

1. **The identity's username wins outright.** When the effective credentials are an identity, at
   any level, its username overrides any host or group username. A host on Identity doesn't
   read its stored username.
2. **Connect-time prompts on identity hosts.**
   - Username is never asked, because identities require one.
   - If the identity has no password and the server asks for one, the dialog asks with no "Save to
     this host" option. Writing a password onto an identity host would be ignored or would corrupt
     its auth type.
   - Saving onto the identity is a possible follow-up, not in scope.
3. **Jump hosts.** Each hop resolves its own credentials, so a bastion may use an identity too. The
   TOTP and password auto-fill state is per hop: once per `login` call. Reusing the same 30 s code
   on two different servers is fine.
4. **Older clients.** No version gate. An older client sees `auth_type: "identity"` as unknown and
   behaves like no saved credentials: it asks, or fails clearly. A group `authType: "identity"` is
   already filtered to unset and falls through. This is the same accepted trade-off as `inherit`
   in PR #33.
5. **Prompt matching.** The code goes only to prompts matching the code regex. A prompt like
   "Password or verification code" matches and gets the code. An identity with TOTP but no
   password, meeting a "Password:" prompt, goes to the dialog.
6. **An identity's key that is deleted or in another vault** is dropped on its own, and the
   identity's username, password and TOTP still apply. This is the same as inherited group keys
   (`usable_key`). Deleting a key gets no new usage warning.
7. **Usage count for delete.**
   - A new Rust command, `identity_usage(identity_id, vault_id) -> { hosts, groups }`, decrypts in
     Rust so no secrets cross IPC.
   - It counts local rows only, so unsynced hosts on other devices aren't counted. The copy says
     "in this vault on this device" only if that is ambiguous; the builder may simplify it to "Used
     by N hosts and M groups".

## Left to the builder

- Exact Keychain tab styling, list row layout and modal copy within the app's style.
- Whether the TOTP preview refreshes every second or every period. Every second is recommended, so
  the countdown moves.
