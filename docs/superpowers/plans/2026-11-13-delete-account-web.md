# Account Deletion — Website Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The privacy policy describes self-service account deletion and the 30-day grace period instead of saying there is no deletion button.

**Architecture:** Copy-only change to one Astro page.

**Tech Stack:** Astro, Biome, vitest.

**Repo:** `/run/media/nahidujjaman-hridoy/5ECC6955CC69288B/terra/shetu-web` (shetu-web), branch `docs/privacy-account-deletion` from `main` (f3f6f7c). **Merge only after the server and client changes ship** (the page must not describe a button users don't have yet).

**Spec:** `/home/nahidujjaman-hridoy/orca/workspaces/client/dogfish/docs/superpowers/specs/2026-11-13-delete-account-design.md`

## Global Constraints

- Plain language, matching the page's existing tone. No AI attribution.
- Checks: `bun run lint`, `bun run check`, `bun run test`, `bun run build` (install with `bun install --frozen-lockfile` first).

## Review Focus

1. The "How long we keep it" section must no longer imply all data is kept "as long as your account exists" without mentioning the 30-day window and the remaining ID record.
2. The GitHub-issue route stays for requests other than deletion (copy of data, corrections), still warning not to post personal details.

---

### Task 1: Privacy policy copy

**Files:** Modify `src/pages/privacy.astro` (the `updated` date, "How long we keep it", "Your choices and rights", and the paragraph after that list).

- [ ] **Step 1: Replace** the list item "You can ask us to delete your account and everything stored with it, or for a copy of the account details we hold." with: "You can delete your account yourself in the app: Settings → Security → Delete account." and "You can ask us for a copy of the account details we hold."
- [ ] **Step 2: Replace** the paragraph starting "The app does not have a self-service account deletion button yet." with:
  > When you delete your account, it is scheduled for deletion 30 days later and you are signed out on every device. To cancel, sign in again within those 30 days and choose "Keep my account". After the scheduled date, our daily cleanup erases your account, your encrypted vault and everything in it, and any teams you own together with their shared vaults; you are removed from other teams. We keep only your account's random ID and the date it was deleted, so devices that were offline can still be told to erase their copy.
  >
  > For other requests, <a href={`${REPOS.monorepo}/issues/new`}>open an issue on GitHub</a> titled "Privacy request". Do not put your email address or other personal details in the issue, since issues are public. We will reply there to confirm your identity privately.
- [ ] **Step 3: Append** to "How long we keep it": "If you delete your account, our daily cleanup erases everything once the scheduled date (30 days later) has passed, except your account's random ID and the date it was deleted. Signing in during those 30 days does not cancel the deletion by itself; you must choose 'Keep my account'."
- [ ] **Step 4: Set** `updated` to the date the PR is merged.
- [ ] **Step 5: Verify** `bun install --frozen-lockfile && bun run lint && bun run check && bun run test && bun run build` — Expected: all succeed; the built `dist/privacy/index.html` contains "Settings → Security → Delete account" and no longer contains "does not have a self-service account deletion button".
- [ ] **Step 6: Commit** `docs(privacy): describe account deletion and the 30-day window`
