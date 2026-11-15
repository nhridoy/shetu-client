# Group Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Groups carry optional credentials and connection options that their hosts (including nested sub-groups) inherit, resolved in Rust at connect time.

**Architecture:**
- A new `host_inherit.rs` walks a host's group chain and resolves the effective values with a pure function. `ssh::load_host_config` uses it, so every connect path inherits.
- A non-secret Tauri command exposes the same resolution to the forms for placeholders and for the forwarding-consent check.
- The frontend gains group payload fields, a merge-safe `updateGroup`, group form sections and host "From group" choices.

**Tech Stack:** Rust (Tauri v2), React 19 + TS, zustand, react-hook-form + zod, vitest.

**Spec:** `docs/superpowers/specs/2026-11-14-group-credentials-design.md` (read "Calls made after the builder check").

**Repo / branch:** `/home/nahidujjaman-hridoy/orca/workspaces/client/dogfish`, branch `feat/group-credentials` (from `origin/main` 2a0be3c).

## Global Constraints

- **Group payload** (encrypted `groups.data`): `username`, `authType` (`password|key|both|none`), `password`, `keyId`, `keepaliveSecs`, `env`, `startup`, `forwardAgent`. Missing or `null` means "not set by this group".
- **Host payload encodings:**
  - `startup`: missing or `null` = **From group**; `{ "none": true }` = None; `{snippetId}` / `{command}` as before.
  - `forwardAgent`: missing or `null` = From group; `true` / `false` = On / Off.
  - `keepaliveSecs`: missing or `null` = "From group / default"; `0` = off; a number = custom.
- **Host auth:** host row `auth_type: "inherit"` = **From group**. Groups never store `"inherit"`.
- **Resolution:**
  - Username: host's own (non-empty) → nearest group → `"root"`.
  - Credentials: the host's own unless `"inherit"`. Under `"inherit"`, use the nearest group that sets `authType`, taking that group's `authType`, `password` and `keyId` together (never mixed across levels). No group sets it → `none`.
  - Keepalive and startup: host → nearest group → default.
  - forwardAgent: host `true/false` → nearest group `true/false` → `false`.
  - Env: merged from the root group down to the host; a later level replaces an earlier entry with the same name; invalid names dropped (`^[A-Za-z_][A-Za-z0-9_]*$`).
- **Chain guards:**
  - At most **16** levels.
  - Stop on a repeated group id, a soft-deleted group, a missing parent, data that fails to decrypt, or a group whose `vault_id` differs from the host's.
  - A group key or snippet outside the host's vault, or deleted, is ignored (the key counts as missing; the snippet gives the existing `MissingSnippet` notice).
  - The connect never fails because of the chain.
- **Under `"inherit"`** the host's own `key_id` and password are ignored, not cleared.
- **Copy (exact):**
  - Auth option label "From group".
  - Username placeholder "From group '{group}': {value}".
  - Credentials note "Using credentials from '{group}'".
  - Keepalive option "From group / default".
  - Startup options "From group" / "None" / "Snippet" / "Command".
  - Forwarding options "From group" / "On" / "Off".
- **Defaults:** a **new** host created in a group whose chain sets `authType` defaults to auth "From group". Startup and forwarding default to "From group" for new hosts in any group. Existing hosts keep their stored values.
- **Never** return passwords or key material from `inherited_host_defaults`; never log secrets.
- **Checks:** `mkdir -p dist && cd src-tauri && cargo test`; `bunx vitest run` (there is no package.json test script); `bunx tsc --noEmit`; `bunx biome check <changed files>` (never `--write` on folders; never `cargo fmt` the whole crate). No AI attribution.

## Review Focus

1. **Renaming, moving or re-sorting a group keeps its credentials** (the old `updateGroup` wrote `"{}"`). Pinned by Task 2 test `updateGroup keeps encrypted fields it did not patch`.
2. **Existing hosts behave exactly as before on upgrade:**
   - a host saved with `auth_type: "password"` and no group settings;
   - a host with `startup: null` under a group that sets nothing;
   - a host with `forwardAgent: false` under a group that sets `true` (stays Off).

   Pinned by Task 1 tests `legacy_host_unchanged_without_group_values` and `host_off_beats_group_on`.
3. **A team host in a group whose `keyId` points at a personal-vault key** never uses that key. Pinned by Task 1 test `group_key_from_other_vault_is_ignored`.
4. **A group loop** (A → B → A) or a chain deeper than 16 terminates and still connects. Pinned by Task 1 test `chain_stops_on_loop_and_depth`.
5. **Inherited agent forwarding still asks for device consent** before forwarding, and the consent check uses the effective value. Pinned by Task 5 test `inherited forwarding asks for consent`.

---

### Task 1: Rust chain resolution + `inherited_host_defaults`

**Files:**
- Create: `src-tauri/src/host_inherit.rs` (`mod host_inherit;` in `lib.rs`, command registered).
- Modify: `src-tauri/src/ssh.rs` `load_host_config` (~1555): use the chain and the resolver; `forward_agent` and `startup` follow the new encodings.
- Test: `host_inherit.rs` `mod tests` for the pure resolver. Chain-walk and `load_host_config` integration tests go in `src-tauri/src/ssh_route.rs` `mod tests`, reusing `fixture()` / `host_with()` / `snippet()` plus a new `group_with(db, crypto, id, vault, parent: Option<&str>, payload, deleted: bool)` helper that encrypts with AAD `"groups"`.

**Interfaces:**
- Produces:
  - `pub(crate) struct GroupLayer { pub id: String, pub name: String, pub vault_id: String, pub payload: serde_json::Value }`.
  - `pub(crate) fn group_chain(db: &LocalDb, crypto: &CryptoState, host_vault: &str, group_id: Option<&str>) -> Vec<GroupLayer>`: nearest first, guards per Global Constraints.
  - `pub(crate) struct Effective`, holding:
    - `username: Option<(String, Option<String>)>`
    - `auth_type: String` (never `"inherit"`)
    - `password: Option<String>`
    - `key_id: Option<String>`
    - `auth_from: Option<String>`
    - `keepalive_secs: Option<(u32, Option<String>)>`
    - `env: Vec<(String, String, Option<String>)>`
    - `startup: (serde_json::Value, Option<String>)`
    - `forward_agent: (bool, Option<String>)`

    In each tuple, the `Option<String>` is the name of the group the value came from (`None` = the host's own, or the default).
  - `pub(crate) fn resolve(host_payload: &Value, host_auth_type: &str, host_key_id: Option<&str>, chain: &[GroupLayer]) -> Effective`: pure.
  - `#[tauri::command] pub fn inherited_host_defaults(group_id: Option<String>, vault_id: String, db, crypto) -> Result<serde_json::Value, String>`. It resolves an empty host payload against the chain and returns `{ username?, usernameFrom?, authType?, authFrom?, hasPassword: bool, keyName?, keepaliveSecs?, keepaliveFrom?, startupKind: "none"|"snippet"|"command"|null, startupFrom?, env: [{name, value, from}], forwardAgent?, forwardAgentFrom? }`. No password and no key text.

- [ ] **Step 1: Write failing tests:**
  - Resolver:
    - `nearest_group_wins_per_field`: parent sets username `a` and keepalive 60; child sets username `b`; host sets nothing → username `b` from child, keepalive 60 from parent.
    - `credentials_resolve_as_one_unit`: child sets `authType:"key"` + `keyId:"k1"`, parent sets `authType:"password"` + `password:"p"`; host `"inherit"` → `key` / `k1` / no password, `auth_from` = child.
    - `inherit_without_group_auth_is_none`.
    - `host_own_auth_ignores_groups`: host `"password"` with its own password, group sets key → password.
    - `env_merges_root_first_host_last`: parent `A=1,B=1`, child `B=2`, host `C=3,A=9` → `A=9,B=2,C=3`; invalid name dropped.
    - `startup_null_inherits_none_marker_blocks`: host `null` + group command → group command; host `{none:true}` + group command → none.
    - `host_off_beats_group_on`: host `false`, group `true` → false.
    - `legacy_host_unchanged_without_group_values`.
  - Chain:
    - `chain_stops_on_loop_and_depth`: A.parent = B, B.parent = A, plus a 20-deep chain. Both terminate, depth ≤ 16, `resolve_saved_route` is Ok.
    - `chain_stops_at_deleted_or_other_vault_group`.
    - `group_key_from_other_vault_is_ignored`: a team host inheriting a group `keyId` that belongs to another vault → no private key, and `load_host_config` is Ok.
    - `inherited_password_reaches_config`: through `load_host_config`.
  - Command:
    - `defaults_never_include_secrets`: the serialized output of `inherited_host_defaults` doesn't contain the group password text or the key PEM, and has `hasPassword: true`.
- [ ] **Step 2: Run** `cargo test host_inherit ssh_route` — Expected: compile FAIL.
- [ ] **Step 3: Implement.**
  - `load_host_config`:
    1. Read the host row.
    2. Build the chain from `row.group_id`.
    3. Call `resolve`.
    4. Load the key from `effective.key_id`. A missing, deleted or other-vault key for an **inherited** key → no key. Keep today's error for the host's own `key_id`.
    5. Load the startup from `effective.startup.0`, where `{none:true}` → `None`, through the existing `load_startup`.
  - Address, port and the jump host stay host-only.
- [ ] **Step 4: Run** `cargo test` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(ssh): inherit credentials and connection options from groups`

### Task 2: Group data in the store (merge-safe)

**Files:** Modify `src/stores/hosts/hostStore.ts` and `src/stores/hosts/hostStore.test.ts`.

**Interfaces:**
- Produces:
  - `Group` gains optional `username`, `authType`, `password`, `keyId`, `keepaliveSecs`, `env`, `startup`, `forwardAgent`, using the same TS types as `Host`'s fields.
  - `getDecryptedGroup(id: string): Promise<Group | null>`.
  - `createGroup` writes the fields to the encrypted plaintext.
  - `updateGroup(id, patch)` decrypts the existing data and writes `{ ...existing, ...definedPatchFields }`.
  - A sanitizer `groupFieldsFromPayload(p)` reusing the `hostFieldsFromPayload` rules: env array of string pairs; startup only `{snippetId}` / `{command}` / `{none:true}` / `null`; forwardAgent `true|false|null`; keepalive a finite number or `null`; authType one of the four values, else `null`.
  - **Host mapping update:** `hostFieldsFromPayload` keeps `startup: {none:true}` and returns `forwardAgent: null` (not `false`) when missing. Junk still maps safely (forwardAgent junk → `null`).

- [ ] **Step 1: Write failing tests:**
  - `updateGroup keeps encrypted fields it did not patch`: existing data `{username:"u", password:"p"}`; patch `{name:"new"}` → plaintext still has both.
  - `createGroup stores credentials only in encrypted data`: plaintext has the fields; row columns don't.
  - `getDecryptedGroup sanitizes junk`: `{authType:"inherit", env:"x", startup:"tmux", forwardAgent:"yes"}` → `authType null`, `env []`, `startup null`, `forwardAgent null`.
  - `host startup none marker and null forwardAgent survive decrypt`.
- [ ] **Step 2: Run** `bunx vitest run src/stores/hosts` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces. Check every existing caller of `updateGroup` (renames, drag-move, reorder); behaviour is unchanged apart from the merge.
- [ ] **Step 4: Run** `bunx vitest run`, `bunx tsc --noEmit` — Expected: pass.
- [ ] **Step 5: Commit** `feat(hosts): store group credentials and options without losing them on edit`

### Task 3: Group form sections

**Files:**
- Modify: `src/components/hosts/forms/GroupForm.tsx`, `src/lib/schema/hosts/groupFormSchema.ts`.
- Extract shared fields from `HostForm.tsx` into `src/components/hosts/forms/ConnectionOptionsFields.tsx` (keepalive, env rows, startup, forwarding) and, if it helps, `CredentialsFields.tsx` (auth method, password, key picker). HostForm uses the extracted components unchanged in behaviour.
- Tests: `GroupForm.test.tsx` (create); keep `HostForm.test.tsx` green.

**Interfaces:**
- Consumes: the Task 2 store API.
- Produces: the shared components with props `{ control, mode: "host" | "group", inherited?: InheritedDefaults }`. `InheritedDefaults` is the TS type of the Task 1 command result, defined in `src/lib/hosts/inherited.ts` with a `fetchInheritedDefaults(groupId: string | null, vaultId: string): Promise<InheritedDefaults>` wrapper.

- [ ] **Step 1: Write failing tests (GroupForm):**
  - It shows collapsed "Credentials" and "Advanced" sections.
  - Saving with username `deploy` and auth password `pw` calls `createGroup` with those fields.
  - Editing an existing group loads its decrypted values (`getDecryptedGroup`) and saving unchanged keeps them.
  - The auth method options don't include "From group".
  - Password is required when auth is password or both; a key is required when auth is key or both.
  - An invalid env name shows the same error as on hosts.
- [ ] **Step 2: Run** `bunx vitest run src/components/hosts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Schema fields mirror the host schema's credential and Advanced fields, with all fields optional and an empty auth method meaning "not set". Group startup choices are None / Snippet / Command, where None stores `null` (a group never stores "From group").
- [ ] **Step 4: Run** `bunx vitest run`, `bunx tsc --noEmit`, biome on the changed files — Expected: pass.
- [ ] **Step 5: Commit** `feat(hosts): credentials and connection options on groups`

### Task 4: Host form "From group" choices

**Files:** Modify `src/components/hosts/forms/HostForm.tsx` (plus the shared components from Task 3), `src/lib/schema/hosts/hostFormSchema.ts`, `src/pages/HostsPage.tsx`, `src/components/hosts/forms/HostForm.test.tsx`, `src/lib/schema/hosts/hostFormSchema.test.ts`.

**Interfaces:**
- Consumes: `fetchInheritedDefaults` (Task 3), Task 1 command, Task 2 mapping.
- Produces: the host form value additions:
  - `authType` may be `"inherit"`;
  - `startupMode`: `"inherit" | "none" | "snippet" | "command"`;
  - `forwardAgentMode`: `"inherit" | "on" | "off"`;
  - `keepaliveMode` `"default"` relabelled "From group / default".

  Submit mapping: `inherit` → startup `null`; `none` → `{none:true}`; forwarding inherit/on/off → `null` / `true` / `false`.

- [ ] **Step 1: Write failing tests:**
  - With the selected group's chain providing username `deploy` from group `prod`, the empty username field shows the placeholder "From group 'prod': deploy", and submitting with it empty is valid.
  - Without a group, or with a chain that has no username, an empty username is invalid.
  - The auth select offers "From group" only when the host has a group. Choosing it hides the password/key fields and shows "Using credentials from 'prod'". The saved `authType` is `"inherit"`.
  - A new host in a group whose chain sets auth defaults to "From group". Editing an existing password host keeps "Password".
  - Startup: a new host in a group defaults to From group (saved `null`). Choosing None saves `{none:true}`. Editing a host with `startup: null` in a group shows From group.
  - Forwarding: From group (default) saves `null`; Off saves `false`; On saves `true`.
  - Inherited env vars show read-only above the host's own rows.
  - Schema: `authType:"inherit"` is valid with no password or key.
- [ ] **Step 2: Run** the focused tests — Expected: FAIL.
- [ ] **Step 3: Implement.** Re-fetch inherited defaults when the selected group changes. Never display a password. Show a key's name only (`keyName`).
- [ ] **Step 4: Run** `bunx vitest run`, `bunx tsc --noEmit`, biome — Expected: pass.
- [ ] **Step 5: Commit** `feat(hosts): hosts inherit credentials and options from their group`

### Task 5: Forwarding consent uses the effective value

**Files:** Modify `src/lib/terminal/agentForwarding.ts` (+ test), and `HostForm.tsx` where consent is recorded on save.

**Interfaces:**
- Consumes: `fetchInheritedDefaults` (Task 3); the host `forwardAgent: true | false | null` (Task 2).
- Produces: `effectiveForwardAgent(host): Promise<boolean>`. Host `true` / `false` wins; `null` → the inherited `forwardAgent ?? false`.

- [ ] **Step 1: Write failing tests:**
  - `inherited forwarding asks for consent`: host `forwardAgent: null` and the group chain provides `true` → the consent dialog appears, and `connect_saved` gets `allowAgentForwarding` per the answer.
  - Host `false` under a group `true` → no dialog, not allowed.
  - HostForm: saving a host whose effective forwarding turns on (On, or From group with an inherited true) records allow for that host. Saving one whose effective forwarding turns off removes the decision.
- [ ] **Step 2: Run** the focused tests — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bunx vitest run`, `bunx tsc --noEmit` — Expected: pass.
- [ ] **Step 5: Commit** `fix(ssh): ask for forwarding consent when forwarding is inherited from a group`

### Task 6: Manual check

- [ ] Run `bun run tauri dev`:
  1. Create group "prod" with username + password.
  2. Create a host inside it with only an address. It connects with the group's login.
  3. Rename the group and connect again; it still works.
  4. Create a sub-group with its own username; a host in it uses the sub-group's username and the parent's password.
  5. Set a group startup command; a host with "From group" runs it, and one with "None" doesn't.
- [ ] Record the results in the ledger. Anything not run goes in the PR body as untested.
