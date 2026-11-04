#!/bin/bash
# Installs the latest Terra on macOS:
#   curl -fsSL https://raw.githubusercontent.com/nhridoy/terra-client/main/install.sh | bash
# Files fetched with curl are not quarantined, so Gatekeeper does not block the
# app the way it does for a browser-downloaded .dmg (Terra is not notarized).
set -euo pipefail

RELEASES='https://github.com/nhridoy/terra-client/releases/latest'
INSTALL_DIR="${TERRA_INSTALL_DIR:-/Applications}"

fail() { echo "Terra install failed: $*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || fail "this installer is for macOS. Download Terra from $RELEASES"

# An Intel terminal under Rosetta reports x86_64; prefer the native build.
if [ "$(uname -m)" = arm64 ] || [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
  label='Apple-Silicon'
else
  label='Intel'
fi

url="$(curl -fsSL "$RELEASES/download/terra-latest.json" | grep -o "https://[^\"]*-macOS-$label\.app\.tar\.gz" | head -n 1)" ||
  fail "could not find a macOS $label build in the latest release"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading Terra for macOS ($label)..."
curl -fL --progress-bar "$url" | tar -xz -C "$tmp"
[ -d "$tmp/Terra.app" ] || fail 'the download did not contain Terra.app'

sudo=''
[ -w "$INSTALL_DIR" ] || sudo='sudo'
$sudo rm -rf "$INSTALL_DIR/Terra.app"
$sudo mv "$tmp/Terra.app" "$INSTALL_DIR/"
echo "Terra installed to $INSTALL_DIR/Terra.app"
