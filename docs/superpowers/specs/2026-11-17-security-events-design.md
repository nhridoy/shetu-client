# Security events — design

Date: 2026-11-17 · Size: project (server + client) · Status: draft for approval

## Intent

A record of what happens to a Shetu account, so its owner can spot something they didn't do,
plus an email when something risky changes. Gap analysis: "Security events log + e-mail on
sensitive changes". Fourth project of the accounts & security phase.

Today the server keeps no history. Emails exist only for two-factor on/off (also via recovery),
backup code used, and account deletion scheduled. A sign-in from a new device, a password change,
a recovery-code reset and a device signed out from elsewhere send nothing. The Devices list shows
only devices signed in now.

## Decided (by the user)

- **History + emails.** A "Recent activity" list in Settings → Security, plus emails for the
  risky events.
- **Each event records** time, event kind, device name + OS, and the IP address. No location
  lookup. Events are kept 90 days and deleted with the account.
- **Behaviour** (played back and confirmed):
  - Recorded:
    - every sign-in (password, Google/GitHub, recovery) with device and IP;
    - wrong passwords, grouped with a count (refined below: per account per hour);
    - wrong two-factor codes, recorded separately;
    - password changed, recovery-code reset;
    - two-factor turned on or off, backup code used;
    - a device signed out (one, or all others);
    - account deletion scheduled or cancelled.
  - Nothing is recorded for an email address with no account.
  - New emails:
    - a sign-in from a device this account has never used;
    - password changed;
    - recovery-code reset;
    - a device signed out from another device;
    - wrong two-factor code ("Someone entered your password but not your code"), at most one
      per hour.
    - No email for wrong passwords.
  - Only the account owner sees their events.
  - Entries can't be deleted, and rows have no actions. If something looks wrong, a line at the
    top points to Devices and Change password.
- **Approach:** a `security_events` table written where each event happens, with emails sent from
  the same helper, and 90-day cleanup in the existing daily purge job.

## Goals / non-goals

- **Goals:** the event list with paging; the events and emails above; retention; deletion with
  the account.
- **Non-goals:**
  - team audit log (teams phase);
  - location/GeoIP;
  - export;
  - per-event actions;
  - notification settings (which emails to receive);
  - events for vault/host/key changes (that's activity, not security).
- **Anti-goals:**
  - recording or emailing never blocks or fails a sign-in or a change (best effort, logged);
  - no event reveals whether an email address has an account;
  - one person hammering a login can't bury the history or flood the inbox;
  - the user can't delete or edit entries.

## Approaches

1. **`security_events` table written at each event site (chosen).** Each event already has one
   place in the server; a helper writes a row and sends the email for risky kinds.
2. **Rebuild history from existing tables** (refresh tokens, devices). Rejected: no failed
   attempts, password changes or recoveries, and rows vanish when tokens are cleaned up.
3. **Event queue or background worker.** Rejected: more moving parts, and events can be lost if
   the server stops; direct writes are cheap at this volume.

## Design

### Server (Go, gin + GORM)

- **Model `SecurityEvent`:**
  - `ID`; `UserID` (indexed, cascade); `Kind` (string);
  - `DeviceID` (may be empty);
  - `IP` (for grouped rows: the latest); `Count` (default 1); `IPCount` (distinct addresses in a
    grouped row, default 1);
  - `Detail` (short string, e.g. provider name or the revoked device's name);
  - `CreatedAt`, plus `LastAt` for grouped rows.
  - Index on `(user_id, created_at)`.
- **Device name and OS are read, not copied** (my call). No sign-in request carries them; the
  app reports them just after sign-in (`PUT /me/devices/current`). So the list joins the
  `devices` row by `device_id` when it is read. A rename shows in old rows too, and devices rows
  outlive revokes, so names stay available. Emails don't name the device; they give the time and
  IP address.
- **Kinds:**
  - `sign_in` (detail: `password` | `google` | `github`);
  - `sign_in_new_device`: replaces `sign_in` when the device id is new for the account;
  - `sign_in_failed`: wrong password, grouped;
  - `two_factor_failed`: wrong two-factor code, grouped the same way;
  - `password_changed`, `recovery_used`;
  - `two_factor_enabled`, `two_factor_disabled`, `backup_code_used`;
  - `device_revoked` (detail: that device's name), `devices_revoked_others` (detail: count);
  - `deletion_scheduled`, `deletion_cancelled`.
- **Helper:** `recordEvent(db, cfg, userID, kind, deviceID, ip, detail)`. It writes the row and,
  for emailing kinds, sends the email in the background through the existing sender. Errors are
  logged, never returned to the request.
  - The two-factor notices move onto this helper, so there is one place that emails.
  - Grouped kinds (`sign_in_failed`, `two_factor_failed`) add to the row for the same
    user + kind whose `CreatedAt` is within the last hour (increment `Count`, set `LastAt` and
    `IP` to the latest, bump `IPCount` when the IP is new to that row), else insert. Per account,
    not per IP (my call): many addresses can't flood the history or the inbox. The row shows
    "N× from M addresses, latest <ip>".
  - The `two_factor_failed` email goes out only when that call inserted a new row, so at most
    once per account per hour.
  - `IPCount` needs the row's distinct addresses: keep them in a small `IPs` text column (comma
    list, capped at 20 entries) on grouped rows; builder's call on the exact storage.
- **Where events are written:**
  - **Sign-ins:** every path that issues a fresh session: login, register, verify-email,
    recovery-then-login, OAuth callback/exchange/setup, and the two-factor verify. Refresh is
    not a sign-in.
  - **Account changes:** password change, recovery (reset), two-factor settings, the backup code
    path, device revoke handlers, deletion schedule/cancel.
  - **Wrong password:** where `HandleLogin` refuses an existing account's proof.
  - **Wrong two-factor code** (my call on scope): only a refused authenticator, backup or emailed
    code. An expired, used-up or locked challenge records nothing more. The email wording
    follows the challenge's path:
    - login: "Someone entered your password but not your two-factor code."
    - oauth: "Someone signed in with Google/GitHub but not your two-factor code."
    - recovery: "Someone used your recovery code but not your two-factor code."
- **New device:** a device id with no `devices` row for the account before this sign-in records
  it. Once the account has devices, a sign-in without a valid device id (an older app, or someone
  leaving it out) also counts as new and emails: leaving the id out must not dodge the alert.
  - An account's first-ever device (no `devices` rows at all, e.g. right after sign-up or the
    first Google/GitHub sign-in) records `sign_in` and sends no email (my call): every new user
    would otherwise get an alarming alert.
- **Recovery** (my call): the recovery-code reset issues no session and carries no device id. It
  records `recovery_used` with the IP and the detail "all devices signed out", and emails. The
  password sign-in that follows is an ordinary `sign_in`. There is no "· Recovery" sign-in
  detail.
- **IP:** `c.ClientIP()`, the same source the rate limiter uses; it follows the existing
  `TRUSTED_PROXIES` setting.
- **API:** `GET /me/security-events?before=<id>&limit=<n>` (protected). It returns the newest
  first, default 50, max 100, `{events: [...], next: <id or null>}`. Each event:
  `{id, kind, detail, device_name, platform, ip, count, ip_count, created_at, last_at,
  current_device}`. `device_name`/`platform` come from the join and may be empty.
- **Retention:** `RunPurgeLoop`'s daily pass also deletes events older than 90 days. Account
  purge deletes the user's events (and the cascade covers it too).
- **Tests:**
  - each event site writes its kind;
  - new-device detection, including no email for a device id seen before;
  - grouping within an hour and a new row after it;
  - `two_factor_failed` emails at most once per hour;
  - an email address with no account records nothing;
  - a recording failure doesn't fail the sign-in;
  - paging; retention; purge.

### Client

- **Settings → Security → Recent activity** (signed-in to a server only, like Devices):
  - newest first, with "Show more";
  - rows: icon (warning style for failed kinds), plain-language title, detail (device name + OS
    when known, IP, "(N× from M addresses)" for grouped rows), relative time;
  - a line at the top: "Something you don't recognise? Sign out that device in Devices and
    change your password."
  - loading, empty ("No activity yet") and error with Retry.
- **Titles:**

  | kind | title |
  | --- | --- |
  | `sign_in` | "Signed in" (`· Google` / `· GitHub`) |
  | `sign_in_new_device` | "New device signed in" |
  | `sign_in_failed` | "Failed sign-ins" |
  | `two_factor_failed` | "Wrong two-factor code" |
  | `password_changed` | "Password changed" |
  | `recovery_used` | "Password reset with recovery code" |
  | `two_factor_enabled` | "Two-factor turned on" |
  | `two_factor_disabled` | "Two-factor turned off" |
  | `backup_code_used` | "Backup code used" |
  | `device_revoked` | "Device signed out: <name>" |
  | `devices_revoked_others` | "Signed out <n> other devices" |
  | `deletion_scheduled` | "Account deletion scheduled" |
  | `deletion_cancelled` | "Account deletion cancelled" |

  Unknown kinds (a newer server) show "Account activity" and are never dropped.
- The row for the event made by this device's session gets "This device".
- **Tests:** rendering of each kind and grouped counts, paging, empty/error states, unknown kind.

## Security notes

- IP addresses are personal data. Events are kept 90 days, are visible only to the owner, and
  are deleted with the account.
- Device names in events are what the app reported (client-supplied); the IP is the only detail
  an attacker can't choose.
- Recording failed attempts for an existing account doesn't leak whether the email exists:
  the response is unchanged.

## Left to the builder

- Exact table layout, index names, and the email wording (short, same tone as the two-factor
  notices, always ending with the "If this wasn't you…" line).
- Whether `sign_in_new_device` also needs a `sign_in` row (no: one row per sign-in).
- Icon choice and row layout, reusing the Devices list styles.

## Calls made without asking

- Grouping window: one hour, per account + kind (not per IP), with the distinct address count.
- Device name/OS joined from `devices` at read time; emails give time + IP, not a device name.
- Wrong two-factor code = a refused code only; email wording by path.
- First-ever device of an account: no new-device email.
- Recovery: `recovery_used` (IP, "all devices signed out"), no recovery-tagged sign-in.
- Page size 50, max 100.
- Two-factor notice emails move onto the new helper (same wording).
- A sign-in without a device id on an account that has devices counts as a new device (changed
  after review: otherwise the alert could be dodged).
