# Host/group form defaults and connect-time prompts — short design

A follow-up to the side-panel forms on PR #33. The user asked for these changes and approved the
summary.

## Group form
- **Credentials:** the Authentication dropdown sits compactly on the right of its label, like the
  vault selector. **The options are unchanged** (user: "ignore for now").
- **Connection:** a new **Port** field (number, 1–65535). Empty means not set. Stored in the group's
  encrypted data as `port: number | null`.
- **Environment:** "+ Add" sits on the right of the section label row.

## Host form
- **Only Address is required.**
  - **Name** is optional. If it is empty at save time, the address is saved as the name.
    Designer's call: list rows don't decrypt the address, so a display-time fallback isn't
    possible. If wrong: renaming the address later doesn't rename the host.
  - **Port** is optional. Empty is saved as `port: null` and resolves host → nearest group → 22.
    Placeholder: "{port} · {group}" or "22".
  - **Username** is optional with or without a group. Empty resolves host → group, and is
    otherwise asked at connect.
- **Login method** keeps "From group", the default in a group. The host option "None" is relabelled
  **"Ask when connecting"**, with the same stored value `none`. It is the default for new hosts
  without a group.
- **Keepalive** becomes a number field: empty = From group/default; `0` = off; 5–600. Placeholder:
  "{n} · {group}", "Off · {group}" or "Default". Startup and agent forwarding stay dropdowns (user's
  choice).
- **Env placeholders:** name "NAME", value "value" on every row.

## Connect-time prompts (interactive terminal connects only)
- **Username:** before `connect_saved`, if neither the host nor its group chain gives a username, a
  dialog asks "Username for {host}" with a **Save to this host** checkbox. The value is passed to
  Rust as a new optional `username` argument, used only when nothing is resolved. If Save is checked
  and the connection reaches "connected", the frontend saves it to the host.
- **Password:**
  - In `ssh_auth::login`, when the password step is reached with no saved password, the server
    allows `password` (or nothing is known yet), and a prompter exists, Shetu asks through the
    existing prompt dialog.
  - The event payload gains `kind: "password"` and `sessionId`. Keyboard-interactive prompts send
    `kind: "keyboard-interactive"`.
  - For `kind: "password"` the dialog shows **Save to this host**. The frontend keeps the typed
    password in memory, keyed by sessionId. Only if that session reaches "connected" does it update
    the host: `password`, and `authType` `password`, or `both` if the host already uses a key. It
    is never logged and is dropped from memory afterwards either way.
- **Background paths never prompt:** ping, OS probe and forwards fail as today.

## Rust
- **Port inheritance:** host payload `port` missing or `null` → nearest group `port` → 22.
  Out-of-range values are ignored.
- `inherited_host_defaults` adds `port` / `portFrom`.
- `connect_saved(…, username: Option<String>)`.
- The login password prompt is as above. Existing tests stay green.

## Unchanged
Inheritance of the other fields, the discard guard, the panel layout and cards, and consent.
