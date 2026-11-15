# Credential Fields (Termius-style) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Authentication dropdown in the host and group forms with Username / Password / "+ Key" fields (plus identity suggestions), and work out `authType` from what is filled.

**Architecture:**
- A pure `deriveAuthType` turns the filled fields into the stored `authType`; it runs at submit.
- `CredentialsFields` owns the whole Credentials card body, username included, for both forms.
- Rust and the stored data are unchanged.

**Tech Stack:** React 19, react-hook-form + zod v4, zustand, vitest + happy-dom.

**Spec:** `docs/superpowers/specs/2026-11-15-credentials-fields-design.md`

## Global Constraints

- **No Authentication dropdown** in either form.
- **authType on save:**
  - identity → `"identity"`;
  - password and key → `"both"`;
  - password → `"password"`;
  - key → `"key"`;
  - nothing:
    - host with a group → `"inherit"`;
    - host without a group → `"none"`;
    - group → `""` (not set).
- **An untouched host stored as `"none"` in a group stays `"none"`.** "Touched" means the user changed username/password/keyId/identityId in this form.
- **A field loads its stored value only when the stored authType uses it:**
  - password: `password` / `both`;
  - keyId: `key` / `both`;
  - identityId: `identity`.
- **Copy:**
  - suggestion entry "+ New identity";
  - button "+ Key";
  - identity chip "{label} ({username})";
  - inherited placeholders:
    - username: "{username} · {group}";
    - password: "•••••• · {group}";
    - identity: "Identity '{label}' · {group}";
    - key: a greyed chip "{keyName} · {group}".
- **Checks:**
  - `bunx vitest run`;
  - `bunx tsc --noEmit`;
  - `bunx biome check --write <changed files only>`.
- **No AI attribution.**

## Review Focus

1. **A key host with a leftover stored password, saved untouched, stays `"key"`.** Pinned by the Task 2 test `a key host with a leftover password saves key`.
2. **An untouched `"none"` host in a group saves `"none"`, not `"inherit"`.** Pinned by the Task 1 test `untouched none stays none` and the Task 2 test `an untouched ask host in a group keeps asking`.
3. **Clearing every credential field:** a host in a group saves `"inherit"`, a host without one saves `"none"`. Pinned by Task 1.
4. **Removing the identity chip then saving uses the plain fields.** Pinned by the Task 2 test `removing the identity chip falls back to the fields`.
5. **A group edited to have no credentials clears authType (null on update).** Pinned by the Task 3 test `clearing a group's login sends null authType`.

---

### Task 1: `deriveAuthType`

**Files:** Create `src/lib/hosts/credentials.ts` and `src/lib/hosts/credentials.test.ts`.

**Interfaces:**
- Produces:
  - `type HostAuthType = "inherit" | "password" | "key" | "both" | "none" | "identity"`;
  - `deriveAuthType(fields: { password?: string; keyId?: string; identityId?: string }, ctx: { mode: "host" | "group"; groupId?: string | null; stored?: string | null; touched: boolean }): HostAuthType | ""`;
  - `ownCredentials(fields): boolean` (true when any of the three is non-empty);
  - `loadedCredentials(stored: string | null | undefined, values: { password?: string | null; keyId?: string | null; identityId?: string | null }): { password: string; keyId: string; identityId: string }` (applies the load rule from Global Constraints).

- [ ] **Step 1: Write tests:**
  - every row of the authType-on-save table;
  - `untouched none stays none` (`stored: "none"`, group set, `touched: false` → `"none"`; `touched: true` → `"inherit"`);
  - `loadedCredentials("key", {password: "old", keyId: "k"})` → `{password: "", keyId: "k", identityId: ""}`;
  - `loadedCredentials("identity", {identityId: "i", password: "p"})` → identity only.
- [ ] **Step 2: Run** `bunx vitest run src/lib/hosts/credentials.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hosts): work out the login method from the filled credential fields`

### Task 2: Credentials card and host form

**Files:** Modify:
- `src/components/hosts/forms/CredentialsFields.tsx` (rewrite the body);
- `HostForm.tsx`:
  - remove its username block and `usesIdentity`;
  - defaults via `loadedCredentials`;
  - submit via `deriveAuthType` with `touched` from `formState.dirtyFields`;
- `useCardSummaries.ts` (credentials summary = `from(!ownCredentials(...) && !!groupId, inherited?.authFrom)`);
- `src/lib/schema/hosts/hostFormSchema.ts`: drop the auth refines (password required, key required, identity required, inherit needs group); `authType` stays as the stored value, not validated against a choice list;
- `HostForm.test.tsx`: replace every `pick("authType", …)` / `optionLabels("authType")` / `#authType` use with field interactions;
- `hostFormSchema.test.ts`.

**Interfaces:**
- Consumes Task 1.
- `CredentialsFields` props stay `{ control, mode, inherited?, resetField? }` and it now renders `username`.
- Element contract for tests:
  - username input `name="username"`;
  - suggestions `role="listbox"` with `role="option"` items;
  - password input `name="password"` plus a show/hide button `aria-label="Show password"`;
  - "+ Key" button opening a `role="listbox"` of keys;
  - key chip with remove button `aria-label="Remove key"`;
  - identity chip with `aria-label="Remove identity"`.

- [ ] **Step 1: Write and update tests in `HostForm.test.tsx`:**
  - `no Authentication dropdown` (no `#authType` element);
  - `password only saves password`;
  - `password and key save both`;
  - `nothing in a group saves inherit, nothing without a group saves none`;
  - `a key host with a leftover password saves key` (existing `{authType: "key", keyId: "k1", password: "old"}`, submit untouched → `authType: "key"`, password field empty);
  - `an untouched ask host in a group keeps asking`;
  - `focusing Username lists identities and New identity`; picking one shows the chip "deploy@prod (deploy)" (mock `getDecryptedIdentity` → username "deploy") and hides password and key;
  - `removing the identity chip falls back to the fields`;
  - `inherited placeholders` (PROD inherited: username placeholder "deploy · prod"; key chip text "deploy-key · prod");
  - the existing identity tests (new-identity modal, deleted identity → now `identityId` reset and no chip, live identity kept) rewritten to the field UI;
  - existing tests that picked "Password" use typing a password instead.
- [ ] **Step 2: Run** `bunx vitest run src/components/hosts/forms/HostForm.test.tsx`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
  - The suggestions open on focus and filter by typed text against identity labels.
  - `onMouseDown` + `preventDefault` keeps input focus while picking.
  - The deleted-identity effect keeps its `getRow` check, but now only resets `identityId` to `""`.
- [ ] **Step 4: Run** `bunx vitest run`, `bunx tsc --noEmit` and biome on the changed files. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hosts): Termius-style credential fields in the host form`

### Task 3: Group form

**Files:** Modify:
- `GroupForm.tsx`:
  - remove its username field (`CredentialsFields` renders it);
  - `valuesFromGroup` uses `loadedCredentials`;
  - `payloadFromForm` uses `deriveAuthType(mode "group")`, and `""` maps to `unset`;
- `src/lib/schema/hosts/groupFormSchema.ts` (drop the auth refines);
- `GroupForm.test.tsx`.

- [ ] **Step 1: Write and update tests:**
  - `group credentials are plain fields` (no `#authType`);
  - `creates a group with username and password credentials` rewritten without picking;
  - `creates a group that logs in with an identity` via the suggestions;
  - `clearing a group's login sends null authType` (edit a `{authType: "password", password: "p"}` group, clear the password → `updateGroup` gets `authType: null, password: null`).
- [ ] **Step 2: Run** `bunx vitest run src/components/hosts/forms/GroupForm.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bunx vitest run`, `bunx tsc --noEmit` and biome. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hosts): Termius-style credential fields in the group form`
