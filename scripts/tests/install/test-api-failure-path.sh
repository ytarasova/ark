#!/usr/bin/env bash
#
# test-api-failure-path.sh -- Regression test for install.sh version resolution
#
# Asserts TWO invariants on docs/install.sh:
#
# 1. When the GitHub endpoint used for version resolution is unreachable or
#    returns an HTTP error, install.sh must exit with a user-friendly
#    "Could not determine latest release" message -- NOT with bash's
#    "error: command not found" (which would mean the function declarations
#    live below their call site, a latent ordering bug).
#
# 2. When the endpoint succeeds, install.sh must resolve the version and
#    proceed to download. (Negative test: verify we can actually exercise
#    the happy path under the mock.)
#
# Root causes being guarded against:
#   a) install.sh used to call the GitHub API (/repos/.../releases) which is
#      rate-limited at 60 req/hr per anonymous IP. When burned, users hit a
#      cryptic 403 followed by "command not found" because info/warn/error
#      were defined below the version-resolution block. The permanent fix
#      replaces the API with the /releases/latest HTTP 302 redirect (no rate
#      limit) AND moves the function declarations to the top of the file.
#   b) A future refactor that moves helpers back below their callers would
#      silently reintroduce the "command not found" failure -- this test
#      catches that.
#
# The test mocks curl to simulate BOTH the version resolution HEAD request
# and the tarball download, so it runs entirely offline and is deterministic.
#
# Runs on Linux and macOS.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
INSTALL_SH="$REPO_ROOT/docs/install.sh"

if [ ! -f "$INSTALL_SH" ]; then
  echo "FAIL: $INSTALL_SH not found"
  exit 2
fi

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

make_mock_curl() {
  # $1 = path to write mock curl to
  # $2 = "fail" or "pass"
  #
  # fail mode: simulate GitHub rate-limited / unreachable for any URL that
  #   matches the version-resolution endpoints (api.github.com/repos or
  #   github.com/.../releases/latest). Return exit 22 + HTTP 403 banner.
  #
  # pass mode: simulate a successful version resolution (return fake headers
  #   with Location: /tag/v0.15.1 for the redirect path and a fake JSON blob
  #   for the API path). Tarball download is not needed because the test
  #   only asserts the resolution banner, not a full install.
  local dst="$1"
  local mode="$2"

  cat > "$dst" <<MOCK
#!/usr/bin/env bash
MODE="$mode"
for arg in "\$@"; do
  case "\$arg" in
    *api.github.com/repos/*releases*|*github.com/*/releases/latest*)
      if [ "\$MODE" = "fail" ]; then
        echo "curl: (22) The requested URL returned error: 403" >&2
        exit 22
      else
        # Return headers that look like a 302 with Location pointing at v0.15.1
        cat <<'HEADERS'
HTTP/2 302
location: https://github.com/ytarasova/ark/releases/tag/v0.15.1
content-length: 0
HEADERS
        # Also return JSON-shaped output for the API scraping path so
        # either version-resolution strategy finds "v0.15.1".
        echo '"tag_name": "v0.15.1"'
        exit 0
      fi
      ;;
    *releases/download/*)
      # Tarball download: install.sh exits here with error if the download
      # fails, which is fine for a resolution-path test (we kill the mock
      # before download succeeds). Return a fake tarball to avoid noise.
      echo "mock tarball body"
      exit 0
      ;;
  esac
done
exec /usr/bin/curl "\$@"
MOCK
  chmod +x "$dst"
}

run_install() {
  # $1 = mode ("fail" | "pass")
  # Echoes combined stdout/stderr, returns install.sh's exit code.
  local mode="$1"
  local work
  work=$(mktemp -d)

  local mockbin="$work/bin"
  mkdir -p "$mockbin"
  make_mock_curl "$mockbin/curl" "$mode"

  # Hermetic env: isolated HOME/ARK_HOME, mock curl ahead of real one, no
  # ARK_VERSION so install.sh MUST take the resolution path.
  env -i \
    PATH="$mockbin:/usr/bin:/bin" \
    HOME="$work/fake-home" \
    ARK_HOME="$work/fake-home/.ark" \
    bash "$INSTALL_SH" 2>&1
  local rc=$?
  rm -rf "$work"
  return $rc
}

# -----------------------------------------------------------------------------
# Test 1: FAILURE PATH -- endpoint unreachable, expect clean error banner
# -----------------------------------------------------------------------------

echo "=== Test 1: API/redirect fails with 403 ==="
FAIL_OUTPUT=$(run_install "fail" || true)

fail1=0

# The fatal sin: bash printed "command not found" -- function ordering regressed.
if echo "$FAIL_OUTPUT" | grep -qi "command not found"; then
  echo "FAIL: install.sh emitted 'command not found' -- function declarations are below their call site"
  echo "--- full output ---"
  echo "$FAIL_OUTPUT"
  fail1=1
fi

# The desired behavior: a human-readable banner from the error() helper.
if ! echo "$FAIL_OUTPUT" | grep -q "Could not determine latest release"; then
  echo "FAIL: expected 'Could not determine latest release' banner, got:"
  echo "--- full output ---"
  echo "$FAIL_OUTPUT"
  fail1=1
fi

if [ "$fail1" = "0" ]; then
  echo "PASS: failure path emits clean error message"
fi

# -----------------------------------------------------------------------------
# Test 2: SUCCESS PATH -- endpoint works, expect version resolved and install
#          progress to at least the download step
# -----------------------------------------------------------------------------

echo ""
echo "=== Test 2: version resolution succeeds ==="
PASS_OUTPUT=$(run_install "pass" || true)

fail2=0

# install.sh echoes "Installing Ark (<VERSION>) to ..." once VERSION is set.
# We expect v0.15.1 from the mock.
if ! echo "$PASS_OUTPUT" | grep -q "Installing Ark (v0.15.1)"; then
  echo "FAIL: expected 'Installing Ark (v0.15.1)' banner, got:"
  echo "--- full output ---"
  echo "$PASS_OUTPUT"
  fail2=1
fi

if [ "$fail2" = "0" ]; then
  echo "PASS: success path resolves version to v0.15.1"
fi

# -----------------------------------------------------------------------------
# Result
# -----------------------------------------------------------------------------

if [ "$fail1" = "0" ] && [ "$fail2" = "0" ]; then
  echo ""
  echo "OVERALL: PASS"
  exit 0
fi

echo ""
echo "OVERALL: FAIL"
exit 1
