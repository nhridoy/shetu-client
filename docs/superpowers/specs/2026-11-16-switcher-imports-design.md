# Switcher imports and host export — design

Date: 2026-11-16 · Size: project (two PRs) · Status: draft for approval

## Intent

People switching from another SSH client should get their hosts into Shetu without retyping
them, and Shetu hosts should be exportable. This is roadmap phase 4 ("Switcher imports").
Today the only import is the user's `~/.ssh/config`.

## Goals

- Import hosts from **PuTTY, WinSCP, Termius (CSV), MobaXterm, SecureCRT, Tabby, iTerm2**,
  alongside the existing ssh_config import.
- **Find the data automatically** in each app's usual place. Otherwise, or on request, the user
  picks an export file.
- Recreate the source app's **folders as groups** (nested). Reuse a group with the same name
  under the same parent.
- Import key files referenced by sessions (including PuTTY `.ppk`) the same way ssh_config
  import does.
- **Export** hosts as an ssh_config snippet or as CSV.

## Non-goals

- Passwords or other stored secrets from the source apps (decided: hosts and key files only).
- Telnet / serial / RDP / FTP / S3 / WebDAV sessions; only SSH-family sessions are imported
  (SFTP/SCP sessions count as SSH hosts).
- Port forwards, terminal colours/fonts, snippets, or per-session terminal settings.
- Keeping Shetu in sync with the other app after import.
- Reading Termius's own app storage. Termius has no export (its docs cover only imports), so
  Termius users go through CSV.

## Anti-goals

- Never write a host, group or key the user didn't see in the preview.
- Never read arbitrary files: the key-read command only reads paths that the last preview listed.
- No silent partial failures: anything skipped is listed in the summary (same as today).
- Export never contains passwords, key material or TOTP secrets.

## Approaches

1. **Rust adapters, one shared flow (chosen).** Each source has a small Rust parser that
   produces the same host list. The ssh_config dialog becomes a general Import dialog with a
   source picker, and all sources share its preview, key import and summary. The registry and
   file access stay in Rust.
2. TypeScript parsers in the webview. Rejected: the registry still needs Rust, and reading key
   files from anywhere would move into the webview.
3. CSV only. Rejected: it doesn't really help switchers.

Shipped as **two PRs** (decided): PR 1 = shared flow + ssh_config moved in + PuTTY + WinSCP +
Termius CSV + export. PR 2 = MobaXterm, SecureCRT, Tabby, iTerm2.

## Design

### Common model (Rust → UI)

Every source returns an `ImportPreview { source, origin, hosts: Vec<ImportedHost>, skipped:
Vec<{ name, reason }> }`:

- `origin`: the detected path or registry key, or the picked file.
- `ImportedHost`: `name`, `hostname`, `port` (default 22), `user` (optional), `key`
  (optional, the same `SshConfigKey` probe as today: path, file name, status
  ready/encrypted/missing/unreadable, fingerprint), `jump` (optional, the name of another host
  in the same preview), `folder: Vec<String>` (path from the root), `tags: Vec<String>`.
- `skipped` lists non-SSH sessions and unreadable entries, with a reason
  (e.g. "Telnet session", "No host name").

`ssh_config_preview` becomes the `ssh_config` source of this model, with its `ProxyJump`
mapped to `jump`, and its Match/scoped-Include notes moved into `skipped`.

Commands:
- `import_detect() -> Vec<{ source, origin }>`: which sources have data in their usual place.
- `import_preview(source, path: Option<String>) -> ImportPreview`: no path means the detected
  location.
- `import_read_key(path) -> String`: only for key paths listed in the most recent preview
  (an allowlist kept in Rust state). This replaces `ssh_config_read_key`. `.ppk` content goes
  through the existing `convert_ppk` before import.

### Sources

| Source | Detected at | File the user can pick | Mapping notes |
|---|---|---|---|
| ssh_config | `~/.ssh/config` | — | unchanged behaviour |
| PuTTY | Windows registry `HKCU\Software\SimonTatham\PuTTY\Sessions`; `~/.putty/sessions/*` elsewhere | `.reg` export (UTF‑16 or UTF‑8) | session names are URL-encoded; `Protocol` must be `ssh`; `HostName` may carry `user@`; `UserName`, `PortNumber`, `PublicKeyFile`; skip `Default Settings`; no folders |
| WinSCP | registry `HKCU\Software\Martin Prikryl\WinSCP 2\Sessions`, else `%APPDATA%\WinSCP.ini` | `WinSCP.ini` | `Folder/Sub/name` session paths (URL-encoded) give folders; `FSProtocol` SFTP/SCP only, others skipped; `HostName`, `UserName`, `PortNumber`, `PublicKeyFile`; tunnel settings noted, not linked |
| Termius | — | CSV | header matched by name, case-insensitive, with aliases: label/name/alias; hostname/address/ip/host (required); port; username/user; group (subgroups split on `/`); tags (split on `,` or `;`); a `protocol` column, if present, keeps only ssh rows |
| MobaXterm (PR 2) | `MobaXterm.ini` in Documents\MobaXterm or `%APPDATA%\MobaXterm` | `.mxtsessions` / `MobaXterm.ini` | `[Bookmarks*]` sections, `SubRep=` folder path; entries `name=#109#…%host%port%user%…` (type 109 = SSH); key path from the session field when present |
| SecureCRT (PR 2) | per-session `.ini` under VanDyke `Config/Sessions` (per OS); subfolders = folders | XML export | `S:"Hostname"`, `S:"Username"`, `D:"[SSH2] Port"` (hex), `S:"Protocol Name"` SSH2 only, `S:"Identity Filename V2"` |
| Tabby (PR 2) | `config.yaml` in Tabby's config dir (per OS) | `config.yaml` | `profiles` with `type: ssh`; `options.host/port/user`, `privateKeys[0]` (`file://` stripped); `group` → folder; `jumpHost` profile id → `jump` |
| iTerm2 (PR 2) | `DynamicProfiles/*.json` and the prefs plist (macOS) | "Save all profiles as JSON" export | profiles whose `Command` is `ssh …`: parse `user@host`, `-p`, `-i`, `-J` (single hop); `Tags` → tags; others skipped |

Windows registry reads are compiled only on Windows. Elsewhere, PuTTY and WinSCP use their
file locations or a picked file.

### UI

- **Hosts page Import button** opens the Import dialog:
  - **Source step:** the sources from `import_detect` are listed as "Found" with their origin.
    Every source also has "Choose file…" (file-picker filters per source; Termius is file-only).
  - **Preview step:** the existing preview, plus a **folder** column showing the target group
    path. Duplicates are matched by name within the target group (reusing today's name check),
    unchecked and marked "exists". Skipped entries are listed under the table.
  - **Import:** groups are created first (parent before child, reusing existing ones by
    name + parent), then keys, then hosts (jump targets before the hosts that use them, as
    today), all inside the group the dialog was opened from.
  - **Summary:** as today.
- **Export:** an **Export** button on the Hosts page exports the open group (with subgroups),
  or everything at the root. It asks ssh_config or CSV, then shows a save dialog.
  - **ssh_config:** one `Host <name>` block per host with `HostName`, `User`, `Port` and
    `ProxyJump <jump name>`. Names with spaces are quoted. Values are the effective ones
    (inherited user/port resolved). There's no `IdentityFile`, because keys live in the vault;
    a comment notes which vault key the host uses.
  - **CSV:** columns `label,address,port,username,group,tags`, which is the same layout the
    Termius CSV import reads, so a Shetu export imports back.
  - Effective values are resolved in Rust (`export_hosts(group_id, format) -> String`);
    addresses and secrets stay out of list state as they are today.

### Data and security

- `import_read_key` reads only paths from the latest preview; the allowlist is replaced per
  preview and cleared when the dialog closes.
- Keys follow the existing import path (encrypted on device, synced). `.ppk` goes through
  `convert_ppk`.
- Missing `user`: the host is created without a username (the existing username prompt asks on
  connect). ssh_config import keeps its current behaviour.
- Export writes only to the path the user picked in the save dialog.

### Decisions from the builder check

- **`.ppk` in the preview:** the Rust probe reads the PPK header. `Encryption: none` is
  converted and fingerprinted, so a key already in the vault is reused. An encrypted `.ppk`
  shows as "encrypted" with no fingerprint and asks for its passphrase once.
  `import_read_key` returns OpenSSH text: a `.ppk` is converted with the typed passphrase,
  through the same code as `convert_ppk`.
- **Groups:** `hostStore.createGroup` returns the created group (today it returns nothing), so
  the import can parent children by id without re-reading the store by name.
- **Duplicates:** a row is "exists" when a host with the same name is already in its target
  group, i.e. the group its folder path resolves to under the dialog's group. If that folder
  group doesn't exist yet, nothing in it is a duplicate.
- **Jump hosts:** `jump` refers to another preview row by that source's own id (ssh_config
  alias, Tabby profile id, iTerm2/`-J` host name). As today: if the target row is unchecked but
  a Shetu host with that name exists in the same target group, link to it; otherwise import
  without a jump host and note it. Ambiguous names (same name in two folders) are noted, not
  guessed.
- **CSV:** RFC 4180 (quoted fields, header row) via the `csv` crate. Tags are joined with `;`
  on export, and `,` or `;` is accepted on import. Group paths are joined with `/`; a `/` inside
  a group name is a known limit (on import it nests). No `protocol` column on export.
- **Key allowlist:** a single global set in Rust state, replaced by each preview (only the
  latest preview's keys can be read) and cleared on dialog close. A picked file can name any
  key path; that is the user's own choice and is shown in the preview before import.
- **Source step:** every source is always listed. Found ones show their origin; the rest offer
  only "Choose file…". ssh_config has no file option (as today).
- **ssh_config:** behaviour and summary wording stay the same. Its tests move to the new model
  but keep their cases.

## Tests (per source)

- Parser unit tests on small fixture texts. Each covers: a normal SSH session, user in host
  name, non-default port, key path, folder nesting, a non-SSH session skipped with a reason,
  URL-encoded or odd names, and empty/invalid input returning an error rather than a panic.
- Detection: a temp-dir fake of each OS location (registry read covered on Windows only).
- `import_read_key` refuses a path not in the latest preview.
- UI: source step (found vs choose file), folder column, groups created and reused, jump
  linking across sources, summary.
- Export: ssh_config and CSV output for nested groups, inherited user, quoted names, no
  secrets; and CSV round-trip through the Termius CSV importer.

## Left to the builder

- Crate choices: an INI parser, `quick-xml`, a maintained YAML fork, `plist`, `winreg` (Windows
  only). Prefer a small hand parser where the format is a few lines (`.reg`, MobaXterm
  entries).
- Exact field positions in MobaXterm entries, from real samples.
- Dialog styling (reuse the existing modal and table).

## Calls made without asking (please check)

- Duplicates are matched by name within the target group, as ssh_config import does today.
- Termius CSV columns are matched by header name with aliases, because Termius's template can't
  be checked without the app; please share a template if you have one.
- Hosts with no user are created without a username, not as `root`.
- Only single-hop jump hosts are linked; anything else is noted in the summary.
- iTerm2 profiles count only when their command is `ssh …`.
- Export resolves inherited values, so the file works on its own.
