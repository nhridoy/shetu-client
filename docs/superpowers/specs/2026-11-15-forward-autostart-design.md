# Port forwards: auto-start and auto-reconnect — design

**Intent.** Tunnels should come back by themselves: after a dropped connection, and on launch or when you open the host. Fifth piece of the terminal-productivity phase. Termius documents only manual start/stop for rules and auto-reconnect for SSH sessions in general; the gap analysis lists auto-start/reconnect as termoso features.

**Design (approved).**
- **Auto-reconnect (always on).** When a running forward's connection drops and the user didn't stop it, it shows "Reconnecting…" and retries after 1, 2, 5, 10, then every 30 seconds until it connects or is stopped. A failure to *start* (bad port, auth, unknown host key) stays "Failed" with no retry.
- **Auto-start, per forward** ("Start automatically"): **Off** (default) · **When Shetu unlocks** — started in the background after unlock, owned by the app, runs until stopped or logout · **With a terminal to this host** — started when a terminal to that host connects (and reconnects), owned by that pane, so closing the pane stops it like today.
- Saved in the forward's encrypted fields (`autoStart`), so it syncs with the forward; no server change.

**Approach.** Rust: `AutoStart` on the definition, a supervising loop in `ForwardingState` that re-runs `prepare` with backoff on unexpected ends, and `auto_start_forwards(trigger)` that starts matching forwards (unlock: all vaults on this device; terminal: that host's). Frontend: form select, "Reconnecting…" status, triggers after unlock and on terminal connect.

**Non-goals.** Per-forward retry settings, auto-start on system boot, reconnect notifications beyond the status.
