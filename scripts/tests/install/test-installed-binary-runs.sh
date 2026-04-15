#!/usr/bin/env bash
#
# test-installed-binary-runs.sh -- Regression test for Bug-010
#
# Asserts: after docs/install.sh finishes, the installed `ark` binary
# actually launches and prints its version.
#
# Why this matters: the Bun-compiled darwin-arm64 release binary has a
# corrupt LC_CODE_SIGNATURE load command. macOS 14+ kernel rejects it at
# launch time with SIGKILL. Users see "zsh: killed" and exit 137. For
# install.sh to be considered "working" it must ship the binary in a state
# that actually launches.
#
# This test drives docs/install.sh against the real v0.14.0 tarball via a
# mocked curl (no network during the test body, but we pre-download the
# real tarball once in the setup section).
#
# Expected outcome:
#   Against current docs/install.sh  -- FAIL (installed binary is SIGKILL'd)
#   After the install-sh fix lands   -- PASS (install.sh repairs signature)
#
# Platform gate: only runs on darwin-arm64. Skip on other platforms.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
INSTALL_SH="$REPO_ROOT/docs/install.sh"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "SKIP: test only valid on Darwin arm64 (detected: $(uname -s) $(uname -m))"
  exit 0
fi
if [ ! -f "$INSTALL_SH" ]; then
  echo "FAIL: $INSTALL_SH not found"
  exit 2
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Stage 1: pre-download the real v0.14.0 tarball to use as mock response
URL="https://github.com/ytarasova/ark/releases/download/v0.14.0/ark-darwin-arm64.tar.gz"
if ! curl -fsSL -o "$WORK/release.tar.gz" "$URL" 2>/dev/null; then
  echo "SKIP: unable to download $URL (network?)"
  exit 0
fi
if [ ! -s "$WORK/release.tar.gz" ]; then
  echo "SKIP: downloaded tarball is empty"
  exit 0
fi

# Stage 2: mock curl to serve the local tarball
MOCK_BIN="$WORK/mock-bin"
mkdir -p "$MOCK_BIN"
cat > "$MOCK_BIN/curl" <<MOCK_CURL
#!/bin/bash
output=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    -o) output="\$2"; shift 2 ;;
    -*) shift ;;
    *)  shift ;;
  esac
done
if [ -n "\$output" ]; then
  cp "$WORK/release.tar.gz" "\$output"
fi
exit 0
MOCK_CURL
chmod +x "$MOCK_BIN/curl"

# Stage 3: run install.sh in sandbox
FAKE_HOME="$WORK/fake-home"
mkdir -p "$FAKE_HOME"

set +e
PATH="$MOCK_BIN:$PATH" \
  ARK_HOME="$FAKE_HOME/.ark" \
  ARK_VERSION="v0.14.0" \
  HOME="$FAKE_HOME" \
  bash "$INSTALL_SH" >"$WORK/install.log" 2>&1
INSTALL_EXIT=$?
set -e
if [ $INSTALL_EXIT -ne 0 ]; then
  echo "SETUP FAIL: install.sh exited $INSTALL_EXIT"
  sed 's/^/  /' "$WORK/install.log"
  exit 2
fi

BIN="$FAKE_HOME/.ark/bin/ark"
if [ ! -f "$BIN" ]; then
  echo "FAIL: binary not installed at $BIN"
  exit 1
fi

# Assertion: the installed binary must actually launch and print version
set +e
OUTPUT=$("$BIN" --version 2>&1)
RC=$?
set -e

if [ $RC -eq 0 ]; then
  echo "PASS: installed binary launches (--version output: $OUTPUT)"
  exit 0
else
  echo "FAIL: installed binary does not launch"
  echo "  exit code: $RC  ($( [ $RC -eq 137 ] && echo 'SIGKILL -- likely Gatekeeper' ))"
  echo "  output:    $OUTPUT"
  echo ""
  echo "  This means install.sh left the corrupt LC_CODE_SIGNATURE in place."
  echo "  The fix is to run"
  echo "    codesign --remove-signature \$BIN_DIR/ark"
  echo "    codesign --force --sign - \$BIN_DIR/ark"
  echo "  after the extract step, on darwin hosts."
  exit 1
fi
