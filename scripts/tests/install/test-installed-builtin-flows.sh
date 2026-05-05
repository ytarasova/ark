#!/usr/bin/env bash
#
# test-installed-builtin-flows.sh -- Regression test for storeBaseDir resolution
# in compiled binaries (the curl-install use case).
#
# Asserts: when the ark binary is launched from <prefix>/bin/ark and the
# tarball layout has the builtin flow definitions at <prefix>/flows/definitions/,
# `ark flow list` MUST show those builtin flows.
#
# Root cause being guarded against:
#   packages/core/app.ts computes `storeBaseDir` from `import.meta.url`. In a
#   Bun-compiled binary that path resolves to /$bunfs/root, NOT to the
#   <prefix> the binary actually lives in. So all four resource stores
#   (flows, skills, agents, runtimes) silently lose their builtin
#   tier and only return user/project content. The user sees `~/.ark/flows/`
#   files but nothing from `~/.ark/flows/definitions/` even though the tarball
#   shipped them.
#
# This is the same bug class as Bug-011 (`ark web` 404), where `WEB_DIST` had
# the identical mistake. The fix shape is identical: prefer
# `dirname(process.execPath)/..` over `import.meta.url` in compiled binaries,
# fall back to source-tree-relative when running from source.
#
# How the test works:
#   1. Compile the real ark binary (`make build-cli`).
#   2. Stage it in a hermetic <tmp>/bin/ark with builtin flows placed at
#      <tmp>/flows/definitions/, exactly mirroring the release tarball.
#   3. Set HOME and ARK_HOME to an empty fake-home so the user tier is empty
#      (no flows in `~/.ark/flows/`). The ONLY way `ark flow list` can show
#      anything is if the binary correctly resolves the builtin tier.
#   4. Run `ark flow list` and grep for known builtin flow names.
#
# Runs on macOS only currently because `make build-cli` produces a darwin
# binary on this host. Linux runners would build their own native binary.
# CI will build per-platform via the existing matrix.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

ARK_NATIVE="$REPO_ROOT/ark-native"
SOURCE_FLOWS="$REPO_ROOT/flows/definitions"

# Pre-flight: source-tree builtin flows must exist (sanity check on the repo).
if [ ! -d "$SOURCE_FLOWS" ]; then
  echo "FAIL: $SOURCE_FLOWS not found -- repo layout changed?"
  exit 2
fi

# Build ark-native if missing. This is the SAME binary a curl-install user
# downloads, just compiled locally instead of in CI.
if [ ! -f "$ARK_NATIVE" ]; then
  echo "ark-native missing, building..."
  (cd "$REPO_ROOT" && make build-cli) >/dev/null 2>&1 || {
    echo "FAIL: make build-cli failed"
    exit 2
  }
fi

if [ ! -x "$ARK_NATIVE" ]; then
  echo "FAIL: $ARK_NATIVE is not executable after build"
  exit 2
fi

# macOS Gatekeeper: re-sign so the binary can launch from a temp path.
if [ "$(uname -s)" = "Darwin" ] && command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "$ARK_NATIVE" >/dev/null 2>&1 || true
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# -----------------------------------------------------------------------------
# Stage the exact installed tarball layout
# -----------------------------------------------------------------------------
PREFIX="$WORK/fake-prefix"
mkdir -p "$PREFIX/bin" "$PREFIX/flows/definitions"
cp "$ARK_NATIVE" "$PREFIX/bin/ark"
chmod +x "$PREFIX/bin/ark"

# Re-sign the staged copy too (codesign is path-bound on macOS).
if [ "$(uname -s)" = "Darwin" ] && command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "$PREFIX/bin/ark" >/dev/null 2>&1 || true
fi

# Copy real builtin flows into the tarball layout. Use a representative subset
# so the test stays fast; the bug doesn't depend on flow count.
for flow in autonomous.yaml autonomous-sdlc.yaml quick.yaml bare.yaml; do
  if [ -f "$SOURCE_FLOWS/$flow" ]; then
    cp "$SOURCE_FLOWS/$flow" "$PREFIX/flows/definitions/$flow"
  fi
done

# Also stage the OTHER resource dirs as empty placeholders so the AppContext
# boot doesn't fail trying to scan a missing dir for skills/agents/etc.
mkdir -p "$PREFIX/skills" "$PREFIX/agents" "$PREFIX/runtimes"

# -----------------------------------------------------------------------------
# Hermetic env: empty $HOME so user-tier flows are guaranteed empty. The
# ONLY flows visible to the binary should come from <prefix>/flows/definitions/.
# -----------------------------------------------------------------------------
FAKE_HOME="$WORK/fake-home"
mkdir -p "$FAKE_HOME"

OUTPUT=$(env -i \
  PATH="/usr/bin:/bin" \
  HOME="$FAKE_HOME" \
  ARK_HOME="$FAKE_HOME/.ark" \
  "$PREFIX/bin/ark" flow list 2>&1)
EXIT_CODE=$?

# -----------------------------------------------------------------------------
# Assertions
# -----------------------------------------------------------------------------
fail=0

if [ "$EXIT_CODE" != "0" ]; then
  echo "FAIL: 'ark flow list' exited $EXIT_CODE"
  echo "--- output ---"
  echo "$OUTPUT"
  fail=1
fi

# Each builtin flow we staged must appear in the output. The bug surfaces here:
# under the broken storeBaseDir resolution, the output is empty (or only shows
# user-tier content, which is empty in this test), so all four greps fail.
for expected in autonomous autonomous-sdlc quick bare; do
  if ! echo "$OUTPUT" | grep -qw "$expected"; then
    echo "FAIL: builtin flow '$expected' missing from 'ark flow list' output"
    fail=1
  fi
done

if [ "$fail" != "0" ]; then
  echo "--- full output ---"
  echo "$OUTPUT"
  echo "--- staged layout ---"
  find "$PREFIX" -maxdepth 3 -type f | head -20
  exit 1
fi

echo "PASS: 'ark flow list' shows all 4 staged builtin flows"
echo "$OUTPUT" | grep -E '^\s*(autonomous|autonomous-sdlc|quick|bare)\b' || true
exit 0
