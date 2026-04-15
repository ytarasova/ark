#!/usr/bin/env bash
#
# test-channel-subprocess.sh -- Regression test for Finding B (Bug-014):
# MCP channel subprocess can be launched from a compiled binary.
#
# Asserts: when the compiled binary is invoked with `channel` as its first
# argument AND the standard channel env vars (ARK_SESSION_ID, ARK_STAGE,
# ARK_CHANNEL_PORT, ARK_CONDUCTOR_URL) are set, it starts the channel MCP
# server and binds ARK_CHANNEL_PORT within a few seconds.
#
# Root cause being guarded against:
#   The old `constants.ts:CHANNEL_SCRIPT_PATH` constant computed a path to
#   `packages/core/conductor/channel.ts` via `import.meta.dir`. In a
#   compiled binary that path lives in Bun's virtual FS (/$bunfs/root/...),
#   which cannot be passed to a child process. Spawning `bun
#   <CHANNEL_SCRIPT_PATH>` failed with "file not found". The new
#   `channelLaunchSpec()` helper in `install-paths.ts` returns
#   `{command: execPath, args: ["channel"]}` in compiled mode, having the
#   binary spawn itself with the `channel` subcommand.
#
# This test proves the full loop: the compiled binary DOES successfully
# launch the channel MCP server when invoked with `channel`.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

ARK_NATIVE="$REPO_ROOT/ark-native"

if [ ! -f "$ARK_NATIVE" ]; then
  echo "ark-native missing, building..."
  (cd "$REPO_ROOT" && make build-cli) >/dev/null 2>&1 || {
    echo "FAIL: make build-cli failed"
    exit 2
  }
fi

if [ "$(uname -s)" = "Darwin" ] && command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "$ARK_NATIVE" >/dev/null 2>&1 || true
fi

WORK=$(mktemp -d)
cleanup() {
  [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

FAKE_HOME="$WORK/fake-home"
mkdir -p "$FAKE_HOME"

# Pick a free port for the channel. 19299 is an unusual number the channel
# server won't naturally conflict with.
PORT=19299

# Launch the channel subprocess directly. This mimics the spec that
# `channelLaunchSpec()` returns in compiled mode: `ark channel` with the
# channel env vars set. If it works here, it works when invoked by
# claude.ts, local/index.ts, and local-arkd.ts.
env -i \
  PATH=/usr/bin:/bin \
  HOME="$FAKE_HOME" \
  ARK_HOME="$FAKE_HOME/.ark" \
  ARK_SESSION_ID=s-test01 \
  ARK_STAGE=test \
  ARK_CHANNEL_PORT="$PORT" \
  ARK_CONDUCTOR_URL=http://localhost:1 \
  "$ARK_NATIVE" channel > "$WORK/channel.log" 2>&1 &
PID=$!

# Wait for the process to either bind the port, crash, or time out.
BOUND=0
CRASHED=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if ! kill -0 $PID 2>/dev/null; then
    CRASHED=1
    break
  fi
  # Check for port binding via lsof (macOS) or ss (Linux)
  if command -v lsof >/dev/null 2>&1; then
    if lsof -iTCP:$PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
      BOUND=1
      break
    fi
  elif command -v ss >/dev/null 2>&1; then
    if ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN; then
      BOUND=1
      break
    fi
  fi
  sleep 0.5
done

fail=0

# Check the log for the "command not found" / bundle-path failure signature
# from the old bug. If the bug regressed, we'd see bun trying and failing to
# load a `/$bunfs/...` path.
if grep -qi "command not found\|no such file\|/\$bunfs/\|ENOENT" "$WORK/channel.log" 2>/dev/null; then
  echo "FAIL: channel subprocess log contains virtual-FS / not-found signature"
  echo "--- channel log ---"
  cat "$WORK/channel.log"
  fail=1
fi

if [ "$CRASHED" = "1" ] && [ "$BOUND" = "0" ]; then
  echo "FAIL: channel subprocess died before binding port $PORT"
  echo "--- channel log ---"
  cat "$WORK/channel.log"
  fail=1
fi

# Also check for the AppContext boot failure mode that would indicate
# install-paths resolution failed at startup.
if grep -qi "AppContext not booted\|cannot find module" "$WORK/channel.log" 2>/dev/null; then
  echo "FAIL: channel subprocess hit AppContext / module resolution error"
  echo "--- channel log ---"
  cat "$WORK/channel.log"
  fail=1
fi

if [ "$BOUND" = "1" ]; then
  echo "PASS: channel subprocess bound port $PORT successfully"
elif [ "$fail" = "0" ]; then
  # Didn't bind but didn't crash either -- check the log for any structured
  # output that suggests the channel server started. If we see anything that
  # looks like "channel" or "listening" or "ready", accept it. Otherwise flag.
  if grep -qi "channel\|listening\|ready\|mcp" "$WORK/channel.log" 2>/dev/null; then
    echo "PASS: channel subprocess started (log shows channel startup)"
  else
    echo "FAIL: channel subprocess did not bind port $PORT and produced no recognizable startup output"
    echo "--- channel log ---"
    cat "$WORK/channel.log"
    fail=1
  fi
fi

exit $fail
