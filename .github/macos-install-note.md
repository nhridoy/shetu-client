
## Installing on macOS

Terra is not notarized by Apple yet, so macOS says it *"cannot verify that this app is free from malware"* the first time you open a downloaded `.dmg`. Pick one:

- **One-line install (no warning):** run this in Terminal. It picks the right build for your Mac (Apple Silicon or Intel):
  ```
  curl -fsSL https://raw.githubusercontent.com/nhridoy/terra-client/main/install.sh | bash
  ```
- **From the `.dmg`:** download `macOS-Apple-Silicon` (M1/M2/M3/M4 Macs) or `macOS-Intel`, drag Terra to Applications and open it once. When the warning appears, go to **System Settings → Privacy & Security** and click **Open Anyway**.

You only do this once. In-app updates install without the warning.
