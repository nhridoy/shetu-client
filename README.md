<p align="center">
  <img src="src-tauri/icons/icon.png" width="96" height="96" alt="Shetu app icon">
</p>

<h1 align="center">Shetu</h1>

<p align="center">
  The free, open-source SSH client for macOS, Windows and Linux.<br>
  A Termius alternative with split terminals, SFTP, port forwarding and an encrypted vault you can sync through your own server.<br>
  <sub><i>Shetu</i> (সেতু) is Bengali for <i>bridge</i>. Say it SHAY-too.</sub>
</p>

<p align="center">
  <a href="https://shetu.iamnahid.com">Website</a> ·
  <a href="https://shetu.iamnahid.com/download">Download</a> ·
  <a href="https://shetu.iamnahid.com/docs">Docs</a> ·
  <a href="https://shetu.iamnahid.com/changelog">Changelog</a> ·
  <a href="https://shetu.iamnahid.com/security">Security</a>
</p>

<p align="center">
  <a href="https://github.com/nhridoy/shetu-client/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/nhridoy/shetu-client"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-8b7cff"></a>
  <img alt="Platforms" src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-x64%20%2B%20ARM64-5b8cff">
</p>

<p align="center">
  <img src="https://shetu.iamnahid.com/og/index.png" width="720" alt="Shetu: free open-source SSH client and Termius alternative">
</p>

## Features

- **Terminal:** GPU-rendered xterm.js, tabs you can reorder, split panes side by side or stacked, focus mode, reconnect and a local shell. 36 themes and 8 terminal fonts.
- **Hosts:** nested groups, tags, colors and OS icons, drag and drop, reachability checks and quick connect.
- **SFTP:** local and remote panes, upload and download with cancel, rename, delete, chmod, chown, symlinks, search, conflict handling and drag and drop.
- **Port forwarding:** local, remote and dynamic (SOCKS5) tunnels, saved and synced with your hosts.
- **Keys:** generate Ed25519, RSA 4096 or ECDSA P-256 keys, or import OpenSSH and PEM keys, passphrase-protected included. Password and public-key authentication, a saved jump host, and a warning when a host key changes.
- **Editor:** CodeMirror with about 20 languages, diff view, Markdown preview and editing of remote files over SFTP, plus a Git panel for local folders.
- **Workspaces:** save a layout of tabs and split panes and bring it back in one click.
- **Session history:** opt-in, encrypted terminal recordings kept for 7, 30 or 90 days.
- **Sync and teams:** sign in to a [Shetu server](https://github.com/nhridoy/shetu-server) (which you can run yourself) to sync your encrypted vault and share team vaults with owner, admin and member roles.

Not there yet: mobile apps, Mosh, Telnet and serial connections, and importing from Termius or `~/.ssh/config`. See what's planned in the [roadmap](https://github.com/nhridoy/shetu#roadmap), and how Shetu compares on the [Termius alternative page](https://shetu.iamnahid.com/termius-alternative).

## Security

- Your account password is turned into a key with **Argon2id** on your device. Sensitive vault fields are encrypted with **XChaCha20-Poly1305** before they are stored or synced.
- Each account has an **X25519** key pair. Every shared team vault has its own key, sealed to each member. Removing someone flags the vault for a key rotation, which an owner or admin completes with **Rotate keys**; after that the removed member can't read new changes.
- The sync server stores ciphertext and never decrypts it. It can see what it needs to sync (record names, tags, timestamps), so keep secrets out of names and tags; host addresses, usernames, passwords, private keys and commands stay encrypted.
- SSH connects from your computer straight to your servers, or through the jump host you set for a host. Nothing goes through Shetu's servers.

Full details: [security reference](https://shetu.iamnahid.com/docs/security).

## Download

Get the build for your system from the [download page](https://shetu.iamnahid.com/download) or [Releases](https://github.com/nhridoy/shetu-client/releases/latest). Files are named by system and CPU. On a Mac, pick `macOS-Apple-Silicon` (M1 and newer) or `macOS-Intel`. On Windows and Linux, pick `x64` (most PCs) or `ARM64`.

The quickest way is one command. It picks the right file for your computer and skips the security warnings below:

- **macOS or Linux** (Terminal):
  ```
  curl -fsSL https://raw.githubusercontent.com/nhridoy/shetu-client/main/install.sh | bash
  ```
  On Debian/Ubuntu it installs the `.deb`. Elsewhere it puts the AppImage at `~/.local/bin/shetu`, which needs `libfuse2` (most distributions have it; otherwise install it with your package manager).
- **Windows** (PowerShell):
  ```
  irm https://raw.githubusercontent.com/nhridoy/shetu-client/main/install.ps1 | iex
  ```

Installing from a downloaded file instead? Shetu isn't notarized by Apple or signed by Microsoft yet, so you'll see a warning the first time:

- **macOS** (*"cannot verify that this app is free from malware"*): drag Shetu to Applications and open it once, then go to **System Settings → Privacy & Security** and click **Open Anyway**.
- **Windows** (*"Windows protected your PC"*): click **More info → Run anyway**. If your browser says the file isn't commonly downloaded, choose **Keep**.

You only do this once. In-app updates install without the warning. Step-by-step guides: [Windows](https://shetu.iamnahid.com/download/windows), [macOS](https://shetu.iamnahid.com/download/macos), [Linux](https://shetu.iamnahid.com/download/linux).

## Reporting a problem

[Open a bug report](https://github.com/nhridoy/shetu-client/issues/new?template=bug_report.yml) and attach your log file. Shetu never logs passwords, keys or terminal output, and removes IP addresses and hostnames from error messages.

- **If Shetu opens:** Settings → Advanced → **Export logs** (or **Report a problem**).
- **If Shetu crashes before it opens,** attach the newest `shetu*.log` from:
  - macOS: `~/Library/Logs/com.nhridoy.shetu/`
  - Windows: `%LOCALAPPDATA%\com.nhridoy.shetu\logs\`
  - Linux: `~/.local/share/com.nhridoy.shetu/logs/` (or `$XDG_DATA_HOME/com.nhridoy.shetu/logs/` if you set `XDG_DATA_HOME`)

Security issues: please report them privately through [GitHub Security Advisories](https://github.com/nhridoy/shetu/security/advisories/new), not a public issue.

## Development

Shetu is a [Tauri v2](https://tauri.app) app: Rust for the native side, React and TypeScript for the interface.

```bash
bun install          # dependencies
bun tauri dev        # run the app in development
bun run vitest run   # tests
```

Building release installers locally needs the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS. Releases are built by CI when a `v*` tag matching the version in `src-tauri/tauri.conf.json` is pushed.

## Related

- [shetu-server](https://github.com/nhridoy/shetu-server): the sync server you can host yourself
- [shetu](https://github.com/nhridoy/shetu): project home and issues
- [shetu-web](https://github.com/nhridoy/shetu-web): the website and docs

## License

[MIT](LICENSE)
