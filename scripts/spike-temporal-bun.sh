#!/usr/bin/env bash
# Phase 0 spike runner -- load @temporalio/worker under Bun and record verdict.
#
# Outputs:
#   .infra/spikes/temporal-bun/result.txt -- full transcript + PASS/FAIL verdict
#
# Exit code mirrors the spike: 0 = Bun compatible, 1 = incompatible, 2 = runner
# error (deps not installed, docker not running, etc.).
#
# This script is idempotent. Re-running it overwrites the previous result.

set -eu

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
SPIKE_DIR="$ROOT/.infra/spikes/temporal-bun"
RESULT="$SPIKE_DIR/result.txt"

mkdir -p "$SPIKE_DIR"

{
  echo "# Ark Temporal / Bun spike"
  echo "# Run: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# Host: $(uname -a)"
  echo "# Bun:  $(bun --version 2>/dev/null || echo 'not installed')"
  echo "# Node: $(node --version 2>/dev/null || echo 'not installed')"
  echo ""
} >"$RESULT"

cd "$SPIKE_DIR"

echo ">>> Installing spike dependencies under Bun (isolated lockfile)..." | tee -a "$RESULT"
if ! bun install --silent >>"$RESULT" 2>&1; then
  echo "FAIL: bun install failed; see $RESULT" | tee -a "$RESULT"
  exit 2
fi

echo "" | tee -a "$RESULT"
echo ">>> Running spike under Bun..." | tee -a "$RESULT"
SPIKE_EXIT=0
bun run worker.ts 2>&1 | tee -a "$RESULT" || SPIKE_EXIT=${PIPESTATUS[0]}

echo "" | tee -a "$RESULT"
echo ">>> Spike exit code: $SPIKE_EXIT" | tee -a "$RESULT"

if [ "$SPIKE_EXIT" -eq 0 ]; then
  echo "VERDICT: Bun compat verified. Worker may run under Bun." | tee -a "$RESULT"
else
  echo "VERDICT: Bun compat NOT verified. Run worker under Node (dual-process deploy)." | tee -a "$RESULT"
fi

exit "$SPIKE_EXIT"
