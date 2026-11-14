# Termoso vs Shetu — gap analysis (2026-11-14)

Source: termoso/termoso @ 7970a9c (AGPL-3.0, v0.9.x, Rust core, Tauri 2 desktop, Axum server,
React web cabinet, Android/iOS). Shetu: client main bf5b01b, server main abd0750.
Evidence: three read-only inventories (termoso desktop, termoso server, Shetu) — paths cited there.

**Licensing:** termoso is AGPL-3.0, Shetu is MIT. Clean-room only: we take feature ideas and UX,
we write our own code. No copying, no porting of files.

## 1. Where Shetu is ahead or different (keep)

- **Built-in code editor with a full Git panel** (CodeMirror, source control). Termoso has
  edit-in-place, not an IDE.
- **Multi-pane SFTP** (more than two panes, each local or remote), chmod/chown, search.
- **Account deletion with a 30-day grace period** that handles owned teams, offline devices and
  teammates' warnings. Termoso deletes immediately and refuses while you own a team.
- **Self-hosting is lighter:** one Go binary, SQLite or Postgres. Termoso needs Postgres + Redis.
- **Google sign-in** (termoso has OIDC/GitHub/SAML — superset, but no Google button out of the box).
- Recently shipped: ssh_config import, palette snippets, 28 rebindable shortcuts, session-history
  recording with retention.

## 2. Existing things Shetu does worse (improve)

| Area | Shetu today | Termoso | Priority |
|---|---|---|---|
| **Host key, first contact** | first-seen key auto-trusted, no prompt | prompt with fingerprint | **P0 security** |
| Client CI | `cargo test` not run in CI | Rust tests + fuzz + smoke in CI | P0 |
| Sync | 30 s polling | push over WebSocket (notify → pull) | P1 |
| Session history | static text viewer | static text too (both lack timed playback) | P2 |
| Transfers | no resume; non-persistent queue | resume, compare, watch-and-upload | P1 |
| Groups | nesting, no inherited settings | credential inheritance through groups | P1 |
| Port forwards | no auto-start, no reconnect | auto-start + backoff reconnect | P1 |
| Snippets | no variables, no bulk run | `{{var}}`, bulk/quiet run, startup snippet | P1 |
| Command palette | terminal-scoped snippets only | global actions + hosts | P2 |
| Themes / fonts | 37 themes, 8 fonts, no editor | 64 themes, editor + importers, 21 fonts + Nerd symbols | P2 |
| Rate limiting | in-memory, no eviction | shared (Redis), per-route | P2 (server) |
| Migrations | GORM AutoMigrate only | 40 versioned forward-only migrations | P2 (server) |

## 3. Missing in Shetu (implement)

Size: S ≈ days, M ≈ 1–2 weeks, L ≈ 3–6 weeks, XL ≈ months. Value: how much users of a
Termius-style client notice it.

### A. SSH core (client)
| Feature | Size | Value |
|---|---|---|
| SSH agent auth + agent forwarding (ssh-agent, Pageant, 1Password/KeePassXC agents) | M | high |
| Keyboard-interactive (server 2FA prompts, auto-TOTP optional) | S–M | high |
| Keepalive + timeouts, per host and global ("global SSH options" from our roadmap) | S | high |
| Env vars + startup command / startup snippet per host | S | high |
| Identities (reusable username + key/password, used by many hosts) | M | high |
| Jump-host chains (multi-hop) | M | med |
| HTTP/SOCKS proxy + ProxyCommand | M | med |
| SSH certificates (user certs) | M | med |
| FIDO2 / security-key (sk-ed25519/ecdsa) | L | med |
| PuTTY `.ppk` import | S | med |
| Post-quantum hybrid KEX toggle | S (if russh supports) | low |
| X11 forwarding | M | low |

### B. Terminal (client)
| Feature | Size | Value |
|---|---|---|
| In-terminal search (xterm search addon) | S | high |
| Broadcast input to several panes | S–M | high |
| Session restore on relaunch (tabs/panes reopen) | M | high |
| Shell integration (OSC 133) + history-based autocomplete | L | med |
| Keyword highlighting / triggers | M | low–med |
| Theme editor + importers, more themes, Nerd-font symbol fallback | M | med |
| ZMODEM, sixel images | M each | low |

### C. Connections (client)
| Feature | Size | Value |
|---|---|---|
| Telnet | M | med |
| Serial | M | med (network gear users) |
| Mosh (needs local mosh-client) | L | med |
| WSL as local shell (Windows) | S | med on Windows |

### D. Files (client)
| Feature | Size | Value |
|---|---|---|
| Transfer resume + persistent queue | M | high |
| Folder compare / watch-and-upload | M | med |
| S3-compatible buckets (AWS, MinIO, R2, B2) | L | med |
| WebDAV | M–L | low–med |

### E. Hosts & import (client)
| Feature | Size | Value |
|---|---|---|
| Sort menu, favourites/recents | S | med |
| Host/vault export (ssh_config, CSV) | S | med |
| Import: PuTTY, Termius CSV, MobaXterm, SecureCRT, WinSCP, Tabby, iTerm2 | M (each S) | high for switchers |
| Cloud import: AWS EC2, DigitalOcean, Azure (API listing, optional auto-sync) | L | med |
| Password-manager references (1Password, Bitwarden, pass, env) resolved at connect | M | med |

### F. Accounts & security (server + client)
| Feature | Size | Value |
|---|---|---|
| Devices list + revoke (live), one session per device | M | high |
| MFA: TOTP + backup codes | M | high |
| Passkeys / WebAuthn | L | med |
| Security events log + e-mail on sensitive changes | M | med |
| Step-up re-auth window for sensitive actions | M | med |
| New-device approval by e-mail | M | med |
| App lock (master password, lock now, inactivity timer) | M | high |
| Realtime sync over WebSocket | L | high |
| Settings + known-hosts sync | M | med |
| OPAQUE password auth (replace verifier scheme) | XL | low–med (ours is already zero-knowledge-ish; big migration) |

### G. Teams (server + client)
| Feature | Size | Value |
|---|---|---|
| Audit / activity log | M–L | high for teams |
| Presence (who is online/connected) | M | med |
| Team policies (MFA required, keys-only, mandatory jump host, export ban, port-forward allow-list, IP allow-list) | L | med |
| Granular roles/permissions | L | med |
| Team SSH CA (short-lived user certs) | L | med |
| Multiplayer terminal (E2E relay, hand-off) | XL | med |
| Access requests / reviews / break-glass, SCIM, SAML | XL | low (enterprise) |

### H. Extras
| Feature | Size | Value |
|---|---|---|
| Opt-in AI command suggestions (privacy-preserving) | M | med |
| Scheduled automations (snippets on host groups, results) | L | low–med |
| Termius-compatible REST API / MCP bridge | L | low |
| i18n (translations) | M + ongoing | med |
| Self-updater opt-in toggle, signature verify | S (we have an updater) | low |
| Web cabinet (account/teams in browser) | L | low–med |
| Mobile apps (Android/iOS) | XL | separate product |

## 4. Recommended order

Every phase is its own design → plan → build → review → PR cycle.

1. **P0 now (small):** host-key prompt on first contact; run `cargo test` in client CI.
2. **SSH essentials:** agent auth/forwarding, keyboard-interactive, keepalive + global SSH options,
   env vars/startup snippet, identities, group-inherited credentials, PPK import.
3. **Terminal productivity:** search, broadcast, session restore, snippet variables + bulk run,
   port-forward auto-start/reconnect, global command palette.
4. **Switcher imports:** PuTTY, Termius, MobaXterm, SecureCRT, …; host export.
5. **Accounts & security:** devices/revoke, TOTP + backup codes, app lock, security events,
   realtime sync.
6. **Files:** resume/persistent queue, compare; then S3, WebDAV.
7. **Connections:** jump chains, proxies, certificates; Telnet, Serial; Mosh later.
8. **Teams:** audit log, presence, policies; SSH CA; multiplayer last.
9. **Extras** as demand shows: AI suggestions, i18n, cloud import, automations, bridge.

Suggest skipping or deferring: mobile apps, SAML/SCIM/access reviews, OPAQUE migration, web cabinet.
