#!/bin/bash
# Installs the latest Terra on macOS or Linux:
#   curl -fsSL https://raw.githubusercontent.com/nhridoy/terra-client/main/install.sh | bash
# Files fetched with curl are not quarantined, so macOS Gatekeeper does not block
# the app the way it does for a browser-downloaded .dmg (Terra is not notarized).
set -euo pipefail

RELEASES='https://github.com/nhridoy/terra-client/releases/latest'

fail() { echo "Terra install failed: $*" >&2; exit 1; }

sudo=''
as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }

case "$(uname -s)" in
  Darwin)
    # An Intel terminal under Rosetta reports x86_64; prefer the native build.
    if [ "$(uname -m)" = arm64 ] || [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
      label='macOS-Apple-Silicon'
    else
      label='macOS-Intel'
    fi
    ext='.app.tar.gz'
    INSTALL_DIR="${TERRA_INSTALL_DIR:-/Applications}"
    ;;
  Linux)
    case "$(uname -m)" in
      x86_64 | amd64) label='Linux-x64' ;;
      aarch64 | arm64) label='Linux-ARM64' ;;
      *) fail "no Linux build for $(uname -m) CPUs" ;;
    esac
    # .deb gets a menu entry and dependencies via apt; elsewhere use the AppImage.
    if command -v apt-get >/dev/null; then ext='.deb'; else ext='.AppImage'; fi
    INSTALL_DIR="${TERRA_INSTALL_DIR:-$HOME/.local/bin}"
    ;;
  *) fail "this installer is for macOS and Linux. Download Terra from $RELEASES" ;;
esac

url="$(curl -fsSL "$RELEASES/download/terra-latest.json" | grep -o "https://[^\"]*-$label${ext//./\\.}" | head -n 1)"
[ -n "$url" ] || fail "could not find a $label build in the latest release"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading Terra ($label$ext)..."
curl -fL --progress-bar "$url" -o "$tmp/terra$ext"

case "$ext" in
  .app.tar.gz)
    tar -xzf "$tmp/terra$ext" -C "$tmp"
    [ -d "$tmp/Terra.app" ] || fail 'the download did not contain Terra.app'
    [ -w "$INSTALL_DIR" ] || sudo='sudo'
    $sudo rm -rf "$INSTALL_DIR/Terra.app"
    $sudo mv "$tmp/Terra.app" "$INSTALL_DIR/"
    echo "Terra installed to $INSTALL_DIR/Terra.app"
    ;;
  .deb)
    chmod 755 "$tmp" # lets apt's _apt user read the file
    as_root apt-get install -y "$tmp/terra.deb"
    echo 'Terra installed. Open it from your app menu or run: Terra'
    ;;
  .AppImage)
    mkdir -p "$INSTALL_DIR"
    mv "$tmp/terra.AppImage" "$INSTALL_DIR/terra"
    chmod 755 "$INSTALL_DIR/terra"
    echo "Terra installed to $INSTALL_DIR/terra (the AppImage needs libfuse2)"
    case ":$PATH:" in *":$INSTALL_DIR:"*) ;; *) echo "Add $INSTALL_DIR to your PATH to run it as: terra" ;; esac
    ;;
esac
