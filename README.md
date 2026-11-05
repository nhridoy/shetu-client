# Terra Client

# Synopsis


# Description

# Example

# Download

Get the latest app from [Releases](https://github.com/nhridoy/terra-client/releases/latest).

## Installing

Files are named by system and CPU. On a Mac, pick `macOS-Apple-Silicon` (M1 and newer) or `macOS-Intel`. On Windows and Linux, pick `x64` (most PCs) or `ARM64`.

The quickest way is one command. It picks the right file for your computer and skips the security warnings below:

- **macOS or Linux** (Terminal):
  ```
  curl -fsSL https://raw.githubusercontent.com/nhridoy/terra-client/main/install.sh | bash
  ```
  On Debian/Ubuntu it installs the `.deb`. Elsewhere it puts the AppImage at `~/.local/bin/terra`, which needs `libfuse2` (most distributions have it; otherwise install it with your package manager).
- **Windows** (PowerShell):
  ```
  irm https://raw.githubusercontent.com/nhridoy/terra-client/main/install.ps1 | iex
  ```

Installing from a downloaded file instead? Terra isn't signed by Apple or Microsoft yet, so you'll see a warning the first time:

- **macOS** (*"cannot verify that this app is free from malware"*): drag Terra to Applications and open it once, then go to **System Settings → Privacy & Security** and click **Open Anyway**.
- **Windows** (*"Windows protected your PC"*): click **More info → Run anyway**. If your browser says the file isn't commonly downloaded, choose **Keep**.

You only do this once. In-app updates install without the warning.

## Reporting a problem

[Open a bug report](https://github.com/nhridoy/terra-client/issues/new?template=bug_report.yml) and attach your log file. Logs never contain passwords, keys, hostnames or terminal output.

- **If Terra opens:** Settings → Advanced → **Export logs** (or **Report a problem**).
- **If Terra crashes before it opens,** attach the newest `terra*.log` from:
  - macOS: `~/Library/Logs/com.nhridoy.terra/`
  - Windows: `%LOCALAPPDATA%\com.nhridoy.terra\logs\`
  - Linux: `~/.local/share/com.nhridoy.terra/logs/`

# Install (development):
`bun install`

# Test:
`bun run vitest run`

#License:
