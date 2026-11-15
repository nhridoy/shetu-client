# Group credentials and inherited host options — design

Phase "SSH essentials", sub-project C, PR 1 of 2. A was connection options (PR #31), B was auth
(PR #32). PR 2 is identities. Source: `docs/analysis/2026-11-14-termoso-gap-analysis.md` §2
("Groups … credential inheritance") and §3.A ("Identities").

## Intent

People with many servers type the same username and key or password, and set the same options,
on every host. Termius and Termoso let a group carry defaults that its hosts inherit.

Success: set credentials and options once on a group. Every host inside it, including hosts in
nested sub-groups, connects with them unless the host overrides a value. Changing the group
changes all of them.

## Goals

**Group form.** Groups gain the same optional sections a host has:
- **Credentials:** username, plus auth method (password, key, both, none) with its password or key.
- **Advanced:** keepalive, environment variables, startup action, "Forward SSH agent".

Every field is optional, and nothing is set by default. Values are stored in the group's
**encrypted data** (`groups.data`), which is `"{}"` today. Group payload:

```json
{
  "username": "deploy",
  "authType": "password|key|both|none",
  "password": "…",
  "keyId": "<key id in the same vault>",
  "keepaliveSecs": null | 0 | n,
  "env": [{ "name": "…", "value": "…" }],
  "startup": null | { "snippetId": "…" } | { "command": "…" },
  "forwardAgent": null | true | false
}
```

A missing field, or a `null` one, means the group doesn't set it.

**Host form, for a host inside a group:**
- **Username:** may be empty, which means inherit. The field shows the inherited value as a
  placeholder: "From group '<name>': <value>". It stays required for hosts with no group, and for
  hosts where no group in the chain sets a username.
- **Auth method:** gains **"From group"**, stored as `authType: "inherit"` in the host row's plain
  `auth_type` column. The server stores it as free text, so no server change is needed.
  - It is the default for **new** hosts created inside a group whose chain sets credentials.
  - Existing hosts keep their stored auth type.
  - With "From group" the password and key fields are hidden. A one-line note says where the
    credentials come from: "Using credentials from '<group>'".
- **Keepalive:** "Use default" becomes "From group / default".
- **Startup:** gains "From group", which becomes the default for hosts in a group.
- **Forward SSH agent:** becomes a three-way choice: **From group** (default), On, Off. It is
  stored as `forwardAgent: null | true | false`. A missing value reads as "From group".
- **Environment variables:** the effective list is the group chain's variables merged with the
  host's. A host variable replaces a group variable of the same name, and order is root group
  first, then the host. The form shows inherited variables read-only above the host's own.

**Resolution, done in Rust at connect time in `ssh::load_host_config`:**
- For each field: the host's own value; else the **nearest** group that sets it, walking
  `parent_id` from the host's group upward; else today's default.
- Groups nest. The walk stops after **16** levels, and on a repeated group id (loop guard).
- A group key (`keyId`) or startup snippet must be in the **host's vault**, and must not be
  deleted. Otherwise it is ignored:
  - a key is treated as no key, and the login falls through as in PR #32;
  - a startup snippet uses the existing `[Startup snippet not found]` notice.
- The chain stops at a group in another vault. Groups and hosts are vault-scoped, so this should
  never happen; it is a guard.
- This applies to every path that loads a saved host: terminal, SFTP, port forwards, ping, OS
  probe, and both hops of a jump-host route.
- An inherited `forwardAgent: true` still needs this device's once-per-host consent (PR #32).
  Consent stays keyed by **host** id.

**Store fix.**
- Today `updateGroup` (`src/stores/hosts/hostStore.ts`) writes the group's encrypted data as
  `"{}"` on every save. It must merge with the existing decrypted data, as `updateHost` does, so
  renaming or moving a group never erases its credentials.
- `createGroup` writes the new fields when given.
- A `getDecryptedGroup` (or equivalent) reads them for the form, with the same junk-tolerant
  mapping as hosts (`hostFieldsFromPayload`).

## Non-goals

- Identities (PR 2); they will plug into this resolution order.
- Inheriting tags, colour, OS, jump host or port forwards.
- Showing the resolved credentials anywhere outside the form; the password is never shown.
- Server changes; none are needed.

## Anti-goals

- Renaming, moving or re-sorting a group wipes its credentials (the current `updateGroup` bug,
  once groups carry data).
- A host silently changing how it logs in on upgrade. Existing hosts keep their stored values,
  and only new hosts default to "From group".
- Secrets crossing IPC or being logged. Resolution stays in Rust, like PR #31 and PR #32.
- A key or snippet from another vault being used, for example a personal key on a team host.
- Inherited agent forwarding without the device's consent.

## Constraints

- Tauri v2 + React 19 client.
- Hosts have plain columns `auth_type`, `key_id` and `group_id`, plus an encrypted payload.
- Groups have plain columns `name`, `parent_id` and `sort_order`, plus encrypted `data`, which the
  server syncs and team rotation re-encrypts already. Groups have no `key_id` column, so a group
  key reference lives in the encrypted data and the server doesn't validate it. Rust checks the
  vault.
- Older clients read `auth_type: "inherit"` as no credentials and try `none`/agent login. They
  lose no data, because `updateHost` merges the payload.
- Reuse PR #31's patterns: the payload fields, `load_host_config`, the HostForm Advanced section
  and the `hostFieldsFromPayload` sanitising.
- Tests first: cargo tests for chain resolution and its guards; vitest for the forms, the store
  merge and the placeholders.
- No AI attribution anywhere.

## Approaches considered

1. **Resolve in Rust at connect** (**chosen**, designer's call; the user handed over the how).
   It is one place, covers every connect path, keeps secrets in Rust, and group edits apply
   immediately.
2. **Copy group values into hosts on save.** These go stale when the group changes, and every edit
   rewrites many hosts. Rejected.
3. **The frontend resolves and passes values to Rust.** That sends secrets over IPC, which the
   codebase deliberately avoids. Rejected.

User decisions: both features, Termius-style, in two PRs (this is PR 1). Hosts inherit
credentials **and** the connection options from PR #31/#32.

## Calls made after the builder check (designer's calls — flagged for review)

1. **Startup encoding.**
   - On a host, a missing or `null` `startup` means **"From group"**, the same as keepalive's
     `null` = "From group / default".
   - The explicit choice **None** is stored as `{ "none": true }`.
   - Upgrading changes nothing: no group sets anything today. Existing hosts saved as `null`
     follow a group's startup only once the user sets one on the group.
   - `forwardAgent` already distinguishes `false` (Off) from missing or `null` (From group).
     Hosts saved since PR #32 store `false`, so they stay Off.
2. **Credentials resolve as one unit; username resolves on its own.**
   - The nearest group that sets `authType` supplies `authType`, `password` and `keyId` together.
     Fields are never mixed across levels.
   - `username` resolves separately: the host's own, else the nearest group's, else today's
     `root` fallback.
   - A host with `"inherit"` whose chain sets no `authType` behaves as `none`, so the agent,
     `none` and keyboard-interactive steps still run as in PR #32.
   - A group with `authType: "key"` and no usable key behaves like a missing key and falls
     through.
3. **Username and auth are independent.** A host can set its own password or key and still
   inherit the username, and the reverse. The form requires a username only when neither the host
   nor its chain provides one.
4. **Deleted or unreadable groups end the chain.** A soft-deleted group, a missing `parent_id`
   target, or data that fails to decrypt stops the walk. Values already resolved are kept and the
   rest fall back to defaults. The connect never fails because of the chain. Deleting a parent
   group doesn't touch its children's rows.
5. **Under `"inherit"` the host's own `key_id` and password are ignored, not cleared.** Switching
   the host back to its own password or key restores them.
6. **Environment variables at group level** use the same name rule as hosts. The form reuses the
   host validation, and Rust drops invalid names. Merge: walk the chain from the root down, then
   the host. A later level replaces an earlier entry with the same name.
7. **The group form** reuses the host schema pieces for credentials and Advanced.
   - `authType: "inherit"` is not offered on groups; a group that sets nothing simply defers to
     its parent.
   - The same refinements apply: password required for password/both, key required for key/both.
8. **Placeholders come from Rust.** A new command `inherited_host_defaults(group_id, vault_id)`
   runs the **same** resolver and returns non-secret values only, each with the name of the group
   it came from:
   - `username`, `authType`, `keepaliveSecs`, `startup` kind, env names and values, `forwardAgent`.
   - Passwords and key material are never returned; only "a password/key is set" and the key's
     name.

   Placeholders therefore never show a value the resolver would skip.

## Left to the builder

- Exact layout of the group form sections, reusing the HostForm Advanced components rather than
  duplicating them.
- How the host form finds the inherited values for its placeholders, provided passwords are never
  displayed.
