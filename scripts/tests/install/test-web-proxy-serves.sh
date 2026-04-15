#!/usr/bin/env bash
#
# test-web-proxy-serves.sh -- Regression test for Finding A (Bug-013):
# web-proxy mode static file serving from an installed tarball layout.
#
# Asserts: when `ark web --server <url>` is run from <prefix>/bin/ark with
# <prefix>/web/ present, the local proxy server serves the SPA index (HTTP
# 200 + <title>Ark</title>) despite the API endpoint being upstream. The
# upstream being unreachable is fine -- we only verify the static file path
# works, which is shared between web.ts and web-proxy.ts through the
# install-paths module.
#
# Why this test exists: PR #92 fixed the same bug in web.ts via resolveWebDist,
# but web-proxy.ts still had the original `join(import.meta.dir, "..."...)`
# mistake. We caught it later in the comprehensive audit. This test guards
# against the proxy path regressing.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

ARK_NATIVE="$REPO_ROOT/ark-native"
SOURCE_WEB="$REPO_ROOT/packages/web/dist"

if [ ! -f "$SOURCE_WEB/index.html" ]; then
  echo "FAIL: $SOURCE_WEB/index.html missing -- run 'bun run packages/web/build.ts' first"
  exit 2
fi

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

# Stage the installed tarball layout
PREFIX="$WORK/fake-prefix"
mkdir -p "$PREFIX/bin" "$PREFIX/web" "$PREFIX/flows/definitions"
cp "$ARK_NATIVE" "$PREFIX/bin/ark"
chmod +x "$PREFIX/bin/ark"
cp -r "$SOURCE_WEB"/* "$PREFIX/web/"
# flows/definitions marker so resolveInstallPrefix() detects the layout
touch "$PREFIX/flows/definitions/.keep"

if [ "$(uname -s)" = "Darwin" ] && command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "$PREFIX/bin/ark" >/dev/null 2>&1 || true
fi

FAKE_HOME="$WORK/fake-home"
mkdir -p "$FAKE_HOME"
PORT=18422

# Launch in proxy mode. The --server URL points at localhost:1 which no one
# listens on; API calls will fail, but we only care about static file serving
# here, which is what the fix targets.
env -i \
  PATH=/usr/bin:/bin \
  HOME="$FAKE_HOME" \
  ARK_HOME="$FAKE_HOME/.ark" \
  "$PREFIX/bin/ark" web --server http://localhost:1 --port "$PORT" > "$WORK/web-proxy.log" 2>&1 &
PID=$!

# Poll for readiness. Capture curl exit separately from its stdout to avoid
# the "000000" concatenation trap (curl writes 000 on failure AND `|| echo`
# would write 000 again, yielding "000000" which would falsely match as an
# HTTP status).
READY=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/" 2>/dev/null)
  curl_exit=$?
  if [ "$curl_exit" = "0" ] && [ -n "$code" ] && [ "$code" != "000" ]; then
    READY=1
    break
  fi
  if ! kill -0 $PID 2>/dev/null; then
    echo "proxy died during readiness poll"
    cat "$WORK/web-proxy.log"
    exit 1
  fi
  sleep 0.5
done

if [ "$READY" != "1" ]; then
  echo "FAIL: proxy never became reachable"
  cat "$WORK/web-proxy.log"
  exit 1
fi

# Probe the SPA index. Do NOT use `|| echo "000"` -- curl's `-w "%{http_code}"`
# already writes "000" on failure, and a `|| echo` fallback would concatenate
# to "000000", hiding the real status.
status=$(curl -s -o "$WORK/index.html" -w "%{http_code}" "http://localhost:$PORT/" 2>/dev/null)
curl_exit=$?
if [ "$curl_exit" != "0" ]; then
  status="curl_exit=$curl_exit"
fi

fail=0
if [ "$status" != "200" ]; then
  echo "FAIL: expected 200 for /, got $status"
  fail=1
fi
if ! grep -q '<title>Ark</title>' "$WORK/index.html" 2>/dev/null; then
  echo "FAIL: response body missing <title>Ark</title>"
  head -c 400 "$WORK/index.html" 2>/dev/null || true
  fail=1
fi

if [ "$fail" != "0" ]; then
  echo "--- proxy log ---"
  cat "$WORK/web-proxy.log"
  exit 1
fi

echo "PASS: web proxy serves SPA index from installed tarball layout"
exit 0
