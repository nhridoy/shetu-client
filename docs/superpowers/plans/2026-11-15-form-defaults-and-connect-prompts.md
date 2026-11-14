# Form Defaults and Connect Prompts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Host forms where only Address is required (empty port/username/credentials inherit or get asked at connect, with save), a group port, keepalive/port as empty-means-default fields, and small group form layout fixes.

**Architecture:**
- Rust resolves the port through the group chain and accepts a username override.
- The login password step asks through the existing prompt dialog, which gains a password kind with a session id.
- The frontend asks for a username before connecting, and saves typed credentials only after the session connects.

**Tech Stack:** Rust (Tauri v2, russh), React 19, Tailwind v4, react-hook-form + zod, vitest.

**Spec:** `docs/superpowers/specs/2026-11-15-form-defaults-and-connect-prompts-design.md`

**Repo / branch:** `/home/nahidujjaman-hridoy/orca/workspaces/client/dogfish`, branch `feat/group-credentials` (PR #33).

## Global Constraints

- **Required fields:** only Address is required on hosts. Name empty → saved as the trimmed address. Port empty → `null`. Username empty → `""` (resolves later).
- **Port resolution:** host `port` (1–65535) → nearest group `port` → 22. Placeholder "{port} · {group}" or "22".
- **Keepalive field:** empty = inherit/default (`null`), `0` = off, otherwise 5–600. Placeholder "{n} · {group}" / "Off · {group}" / "Default".
- **Host login option** "None" is relabelled **"Ask when connecting"** (stored value `none`). It is the default for new hosts without a group; inside a group the default stays "From group".
- **Group Authentication** options are unchanged. The dropdown moves to the right of its label.
- **Env placeholders:** name "NAME", value "value". Group env "+ Add" goes on the right of the label row.
- **Prompt event** `ssh-auth-prompt` gains `kind: "password" | "keyboard-interactive"` and `sessionId`. Password prompt text is exactly "Password".
- **Username dialog:** title "Username for {host}", checkbox "Save to this host".
- **Password dialog:** checkbox "Save to this host" for `kind: "password"` only.
- **Saving credentials:** only after that session reaches "connected". Password saves set `authType` to `password` (or `both` if the host's own auth is `key`). Typed secrets are never logged and are dropped after use.
- **Prompts:** only interactive terminal connects prompt. Ping, probe and forwards never do.
- **Checks:** `mkdir -p dist && cd src-tauri && cargo test`; `bunx vitest run`; `bunx tsc --noEmit`; `bunx biome check <changed files>` (never `--write` on folders; never `cargo fmt` the whole crate). No AI attribution.

## Review Focus

1. **Existing hosts with a numeric port, and auth `none` hosts, behave as before** apart from the new password prompt on interactive connects. Pinned by Task 1 test `legacy_port_unchanged` and the existing ssh_auth tests.
2. **A wrong typed password with "Save" checked is never saved** (the connection never reaches "connected"). Pinned by Task 4 test `failed login does not save password`.
3. **Background connects never prompt for a password.** Pinned by Task 1 test `non_interactive_skips_password_prompt`.
4. **Saving a host with every optional field empty** stores name = address, port null and username "", and can still connect through the group. Pinned by Task 2 test `only address required`.

---

### Task 1: Rust — port inheritance, username override, password prompt

**Files:** Modify `src-tauri/src/host_inherit.rs`, `src-tauri/src/ssh.rs` (`load_host_config`, `connect_saved`, prompter payload), `src-tauri/src/ssh_auth.rs` (password step) + tests (`host_inherit` mod tests, `ssh_route.rs` mod tests, `ssh_auth` mod tests).

**Interfaces:**
- Produces:
  - `Effective.port: (u16, Option<String>)`;
  - `inherited_host_defaults` JSON gains `port?` and `portFrom?`;
  - `connect_saved(…, username: Option<String>)`, used only when no username resolves;
  - `AuthPromptRequest` gains `kind: PromptKind { Password, KeyboardInteractive }`;
  - the `ssh-auth-prompt` payload gains `kind` ("password" | "keyboard-interactive") and `sessionId`.

- [ ] **Step 1: Write failing tests:**
  - `port_inherits_from_group`: host `port: null` + group 2222 → 2222 from the group.
  - `legacy_port_unchanged`: host 2200 → 2200.
  - `invalid_port_ignored`: host 0 or 70000 → group/22.
  - `username_override_used_when_unresolved`; `username_override_ignored_when_resolved`.
  - ssh_auth:
    - `password_prompted_when_none_saved`: no saved password, server allows password, prompter returns `Some(["pw"])` → Ok, and the prompter received kind Password.
    - `non_interactive_skips_password_prompt`: prompter `None` → no password attempt.
    - `password_prompt_cancel_is_login_cancelled`.
  - `defaults_include_port`.
- [ ] **Step 2: Run** `cargo test` — Expected: FAIL.
- [ ] **Step 3: Implement.** The password prompt happens only once per connection, never after a rejected saved password (that goes to keyboard-interactive as today), and respects `remaining_methods`.
- [ ] **Step 4: Run** `cargo test` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(ssh): inherit the port from groups and ask for a missing password at login`

### Task 2: Schemas, store and saved values

**Files:** Modify `src/lib/schema/hosts/hostFormSchema.ts` (+ test), `src/lib/schema/hosts/groupFormSchema.ts` (+ test), `src/stores/hosts/hostStore.ts` (+ test, port null/group port), `src/components/hosts/forms/HostForm.tsx` and `GroupForm.tsx` submit mapping only, `src/lib/hosts/inherited.ts` (type: `port`, `portFrom`), `src/lib/hosts/inheritedLabels.ts` (+ test: `portLine`, keepalive placeholder text).

**Interfaces:**
- Consumes: the Task 1 JSON fields.
- Produces:
  - The host schema: `name`, `port`, `username` optional; `keepaliveSecs` optional (empty = null).
  - The group schema gains `port` (optional, 1–65535).
  - `portLine(i?)` → "{port} · {group}" | "22"; `keepalivePlaceholder(i?)` → "{n} · {group}" | "Off · {group}" | "Default".

- [ ] **Step 1: Write failing tests:**
  - `only address required`: name/port/username empty is valid; saving maps to name = address, port null, username "".
  - Port 0 or 70000 is invalid.
  - Group `port` is saved in the encrypted payload and decrypt-sanitized (junk → null).
  - Keepalive empty → `null`, `0` → 0, `3` invalid.
  - `portLine` / `keepalivePlaceholder` strings.
- [ ] **Step 2: Run** the focused vitest — Expected: FAIL.
- [ ] **Step 3: Implement.** Keep `keepaliveMode` removal consistent: replace the mode select + custom number with the single number field semantics in the schema/submit mapping. Task 3 does the UI.
- [ ] **Step 4: Run** `bunx vitest run`, `bunx tsc --noEmit` — Expected: pass.
- [ ] **Step 5: Commit** `feat(hosts): only the address is required; empty port and keepalive inherit`

### Task 3: Form controls and layout

**Files:** Modify `src/components/hosts/forms/HostForm.tsx`, `GroupForm.tsx`, `CredentialsFields.tsx`, `ConnectionOptionsFields.tsx` + tests.

**Interfaces:**
- Consumes: the Task 2 schema/helpers and `inherited.port`.

- [ ] **Step 1: Write failing tests:**
  - Host:
    - Only Address shows the required asterisk.
    - The Port and Keepalive inputs are empty with the resolved placeholders.
    - The login option label is "Ask when connecting", and it's the default for a new host without a group.
  - Group:
    - The Authentication select sits in the label row, after the label text and to its right, within the same row container.
    - A Port field is in Connection.
    - The Environment "+ Add" button is in the label row.
  - Env inputs have placeholders "NAME" / "value".
- [ ] **Step 2: Run** the focused tests — Expected: FAIL.
- [ ] **Step 3: Implement.** Use the existing kit. The inline auth select is a compact `Select` sized like the VaultSelector trigger.
- [ ] **Step 4: Run** `bunx vitest run`, `bunx tsc --noEmit`, biome — Expected: pass.
- [ ] **Step 5: Commit** `feat(hosts): simpler form controls with empty-means-default fields`

### Task 4: Connect-time username and password prompts with save

**Files:** Modify `src/lib/terminal/agentForwarding.ts` (`connectSavedTerminal`), `src/components/connection/AuthPromptDialog.tsx` (+ test), add a username dialog (reuse `src/components/ui/PromptDialog.tsx` if it fits) and a small `src/lib/terminal/pendingCredentials.ts` (+ test) keyed by sessionId, and wire the "connected" event in `src/lib/terminal/sessionManager.ts`.

**Interfaces:**
- Consumes: the Task 1 `username` arg and `kind`/`sessionId` in the prompt payload; `fetchInheritedDefaults`; `updateHost`.

- [ ] **Step 1: Write failing tests:**
  - `asks username when none resolves`: host has no username, no group username → the dialog shows; the answer is passed as `username` to `connect_saved`; cancel aborts the connect.
  - `no username dialog when group provides one`.
  - `password dialog shows Save for password kind only`.
  - `save after connected`: Save checked + a "connected" event for that session → `updateHost(hostId, { password, authType: "password" })` (or `both` when the host's auth is `key`).
  - `failed login does not save password`: no "connected" → no updateHost, and the pending entry is cleared on "disconnected"/"error".
  - Username save only after connected.
- [ ] **Step 2: Run** the focused tests — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bunx vitest run`, `bunx tsc --noEmit`, biome; `cargo test` if Rust changed — Expected: pass.
- [ ] **Step 5: Commit** `feat(ssh): ask for a missing username or password when connecting, and save on request`
