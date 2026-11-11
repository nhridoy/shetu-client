#!/bin/bash
# Installs the latest Shetu on macOS or Linux:
#   curl -fsSL https://raw.githubusercontent.com/nhridoy/shetu-client/main/install.sh | bash
# Files fetched with curl are not quarantined, so macOS Gatekeeper does not block
# the app the way it does for a browser-downloaded .dmg (Shetu is not notarized).
set -euo pipefail

RELEASES='https://github.com/nhridoy/shetu-client/releases/latest'
DOWNLOADS='https://github.com/nhridoy/shetu-client/releases/download/'

fail() { echo "Shetu install failed: $*" >&2; exit 1; }

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
    INSTALL_DIR="${SHETU_INSTALL_DIR:-/Applications}"
    ;;
  Linux)
    case "$(uname -m)" in
      x86_64 | amd64) label='Linux-x64' ;;
      aarch64 | arm64) label='Linux-ARM64' ;;
      *) fail "no Linux build for $(uname -m) CPUs" ;;
    esac
    # .deb gets a menu entry and dependencies via apt; elsewhere use the AppImage.
    if command -v apt-get >/dev/null; then ext='.deb'; else ext='.AppImage'; fi
    INSTALL_DIR="${SHETU_INSTALL_DIR:-$HOME/.local/bin}"
    ;;
  *) fail "this installer is for macOS and Linux. Download Shetu from $RELEASES" ;;
esac

# Only this repo's release downloads count, so a URL inside the release notes can't redirect the install.
url="$(curl -fsSL "$RELEASES/download/shetu-latest.json" | grep -o "${DOWNLOADS//./\\.}[^\"]*-$label${ext//./\\.}" | head -n 1)" ||
  fail "could not find a $label build in the latest release"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading Shetu ($label$ext)..."
curl -fL --progress-bar "$url" -o "$tmp/shetu$ext"

case "$ext" in
  .app.tar.gz)
    tar -xzf "$tmp/shetu$ext" -C "$tmp"
    [ -d "$tmp/Shetu.app" ] || fail 'the download did not contain Shetu.app'
    [ -w "$INSTALL_DIR" ] || sudo='sudo'
    $sudo mkdir -p "$INSTALL_DIR"
    $sudo rm -rf "$INSTALL_DIR/Shetu.app"
    $sudo mv "$tmp/Shetu.app" "$INSTALL_DIR/"
    echo "Shetu installed to $INSTALL_DIR/Shetu.app"
    ;;
  .deb)
    chmod 755 "$tmp" && chmod 644 "$tmp/shetu.deb" # lets apt's _apt user read it under any umask
    as_root apt-get install -y "$tmp/shetu.deb"
    echo 'Shetu installed. Open it from your app menu or run: Shetu'
    ;;
  .AppImage)
    mkdir -p "$INSTALL_DIR"
    # Stage next to the target so the final rename is atomic and an old copy survives a failed copy.
    cp "$tmp/shetu.AppImage" "$INSTALL_DIR/.shetu.new"
    chmod 755 "$INSTALL_DIR/.shetu.new"
    mv -f "$INSTALL_DIR/.shetu.new" "$INSTALL_DIR/shetu"
    echo "Shetu installed to $INSTALL_DIR/shetu (the AppImage needs libfuse2)"
    case ":$PATH:" in *":$INSTALL_DIR:"*) ;; *) echo "Add $INSTALL_DIR to your PATH to run it as: shetu" ;; esac
    ;;
esac
