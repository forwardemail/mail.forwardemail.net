#!/bin/sh
# Forward Email for the terminal: installer for Linux and macOS.
#
#   curl -fsSL https://github.com/forwardemail/mail.forwardemail.net/releases/latest/download/install.sh | sh
#
# Downloads the standalone `forwardemail` executable for this machine from
# the latest GitHub release, checks it against the release's SHA256SUMS.txt
# and installs it to ~/.local/bin, where it can update itself.
#
# Environment:
#   FORWARDEMAIL_VERSION      install this version (e.g. 0.15.0) instead of the latest
#   FORWARDEMAIL_INSTALL_DIR  install here instead of ~/.local/bin
#
# https://github.com/forwardemail/mail.forwardemail.net/blob/main/docs/CLI.md

set -eu

REPOSITORY="forwardemail/mail.forwardemail.net"
VERSION="${FORWARDEMAIL_VERSION:-latest}"
INSTALL_DIR="${FORWARDEMAIL_INSTALL_DIR:-$HOME/.local/bin}"

fail() {
  printf 'forwardemail install: %s\n' "$1" >&2
  exit 1
}

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "unsupported system $(uname -s); on Windows use install.ps1, anywhere else: npm install -g forwardemail" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "unsupported CPU $(uname -m); install with npm instead: npm install -g forwardemail" ;;
esac

# The binaries are built against glibc.
if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
  fail "musl-based Linux (e.g. Alpine) is not supported by the standalone binary; install with npm instead: npm install -g forwardemail"
fi

# Intel builds run on Apple Silicon too, but a native one is faster.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi

asset="forwardemail-${os}-${arch}.gz"
if [ "$VERSION" = latest ]; then
  base="https://github.com/${REPOSITORY}/releases/latest/download"
else
  base="https://github.com/${REPOSITORY}/releases/download/v${VERSION#v}"
fi

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
else
  fail "curl or wget is required"
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  fail "sha256sum or shasum is required to verify the download"
fi

tmp="$(mktemp -d 2>/dev/null || mktemp -d -t forwardemail)"
trap 'rm -rf "$tmp"' EXIT INT TERM

printf 'Downloading %s (%s)...\n' "$asset" "$VERSION"
fetch "${base}/${asset}" "${tmp}/${asset}" || fail "could not download ${base}/${asset}"
fetch "${base}/SHA256SUMS.txt" "${tmp}/SHA256SUMS.txt" || fail "could not download ${base}/SHA256SUMS.txt"

expected="$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "${tmp}/SHA256SUMS.txt")"
[ -n "$expected" ] || fail "SHA256SUMS.txt does not list ${asset}"
actual="$(sha256 "${tmp}/${asset}")"
[ "$expected" = "$actual" ] || fail "checksum mismatch for ${asset} (expected ${expected}, got ${actual})"

gunzip -c "${tmp}/${asset}" >"${tmp}/forwardemail" || fail "could not decompress ${asset}"
chmod 755 "${tmp}/forwardemail"

mkdir -p "$INSTALL_DIR" || fail "could not create ${INSTALL_DIR}"
mv -f "${tmp}/forwardemail" "${INSTALL_DIR}/forwardemail" || fail "could not write ${INSTALL_DIR}/forwardemail"

installed="$("${INSTALL_DIR}/forwardemail" --version 2>/dev/null || true)"
printf 'Installed Forward Email %s to %s/forwardemail\n' "${installed:-$VERSION}" "$INSTALL_DIR"

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*)
    printf 'Run: forwardemail\n'
    ;;
  *)
    printf '\n%s is not on your PATH. Add it, for example:\n' "$INSTALL_DIR"
    printf '  echo '\''export PATH="%s:$PATH"'\'' >> ~/.profile\n' "$INSTALL_DIR"
    printf 'then open a new terminal and run: forwardemail\n'
    ;;
esac
