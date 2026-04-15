#!/usr/bin/env bash
#
# test-symlink-preservation.sh -- Regression test for Bug-011
#
# Asserts: running docs/install.sh against an install dir that contains a
# pre-existing symlink (e.g. from a prior `make install`) must NOT write
# the new binary through the symlink to the symlink's target.
#
# Why this matters: a developer who has run `make install` has
# ~/.ark/bin/ark as a symlink pointing at <repo>/ark (the source-tree bash
# wrapper). If install.sh's `cp -R` follows that symlink, it clobbers the
# repo's ark file -- a file that's tracked in git and not owned by
# ~/.ark/.
#
# Expected outcome:
#   Against current docs/install.sh  -- FAIL (cp -R follows destination symlinks)
#   After the fix lands              -- PASS
#
# Runs on Linux and macOS. No network required -- curl is mocked.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
INSTALL_SH="$REPO_ROOT/docs/install.sh"

if [ ! -f "$INSTALL_SH" ]; then
  echo "FAIL: $INSTALL_SH not found"
  exit 2
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# ── Stage 1: fake source repo with a bash wrapper ─────────────────────────
REPO="$WORK/fake-repo"
mkdir -p "$REPO"
cat > "$REPO/ark" <<'WRAPPER'
#!/bin/bash
# Source-tree ark bash wrapper (this is what `make install` symlinks to)
exec bun packages/cli/index.ts "$@"
WRAPPER
chmod +x "$REPO/ark"
SHA_BEFORE=$(shasum "$REPO/ark" | awk '{print $1}')

# ── Stage 2: fake ARK_HOME with the make-install symlink already in place ─
FAKE_HOME="$WORK/fake-home"
mkdir -p "$FAKE_HOME/.ark/bin"
ln -sf "$REPO/ark" "$FAKE_HOME/.ark/bin/ark"
[ -L "$FAKE_HOME/.ark/bin/ark" ] || { echo "SETUP FAIL: symlink"; exit 2; }

# ── Stage 3: fake tarball carrying a new binary payload ───────────────────
TARBALL_ROOT="$WORK/tarball-root"
detect_platform() {
  local os arch
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m)
  case "$os" in darwin) os=darwin ;; linux) os=linux ;; esac
  case "$arch" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; esac
  echo "${os}-${arch}"
}
PLATFORM=$(detect_platform)
mkdir -p "$TARBALL_ROOT/ark-${PLATFORM}/bin"
printf 'FAKE-ARK-BINARY-PAYLOAD-DO-NOT-RUN' > "$TARBALL_ROOT/ark-${PLATFORM}/bin/ark"
chmod +x "$TARBALL_ROOT/ark-${PLATFORM}/bin/ark"
(cd "$TARBALL_ROOT" && tar -czf "$WORK/fake.tar.gz" "ark-${PLATFORM}")

# ── Stage 4: mock curl that serves the local tarball ──────────────────────
MOCK_BIN="$WORK/mock-bin"
mkdir -p "$MOCK_BIN"
cat > "$MOCK_BIN/curl" <<MOCK_CURL
#!/bin/bash
# Mock curl: satisfies "-o <path> <url>" by copying our staged tarball.
output=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    -o) output="\$2"; shift 2 ;;
    -O) shift ;;
    --) shift; break ;;
    -*) shift ;;
    *)  shift ;;
  esac
done
if [ -n "\$output" ]; then
  cp "$WORK/fake.tar.gz" "\$output"
fi
exit 0
MOCK_CURL
chmod +x "$MOCK_BIN/curl"

# ── Run install.sh in sandbox ─────────────────────────────────────────────
# ARK_VERSION skips the "resolve latest release" curl call.
# ARK_HOME redirects the install dir.
# HOME redirects shell rc file discovery.
# PATH puts mock curl ahead of real curl.
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

# ── Assertions ────────────────────────────────────────────────────────────
FAIL=0

SHA_AFTER=$(shasum "$REPO/ark" | awk '{print $1}')
if [ "$SHA_BEFORE" = "$SHA_AFTER" ]; then
  echo "PASS 1: repo ark wrapper unchanged"
else
  echo "FAIL 1: install.sh clobbered the repo ark wrapper"
  echo "  before sha: $SHA_BEFORE"
  echo "  after  sha: $SHA_AFTER"
  echo "  first bytes of repo file now:"
  head -c 40 "$REPO/ark" | od -c | head -2 | sed 's/^/    /'
  FAIL=1
fi

TARGET="$FAKE_HOME/.ark/bin/ark"
if [ -L "$TARGET" ]; then
  echo "FAIL 2: $TARGET is still a symlink (should be replaced by real file)"
  FAIL=1
elif [ ! -f "$TARGET" ]; then
  echo "FAIL 2: $TARGET missing"
  FAIL=1
elif grep -q 'FAKE-ARK-BINARY-PAYLOAD' "$TARGET"; then
  echo "PASS 2: install dir has real binary with tarball content"
else
  echo "FAIL 2: $TARGET does not have tarball payload"
  head -c 40 "$TARGET" | od -c | head -2 | sed 's/^/    /'
  FAIL=1
fi

if [ $FAIL -eq 0 ]; then
  echo "ALL PASS"
  exit 0
else
  exit 1
fi
