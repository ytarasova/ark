#!/usr/bin/env bash
#
# build-fly-image.sh -- build + push the arkd-bundled image that
# FlyMachinesCompute pulls when provisioning a Fly machine.
#
# Usage:
#   FLY_API_TOKEN=... ./scripts/build-fly-image.sh
#   FLY_APP=ark-arkd TAG=v2 ./scripts/build-fly-image.sh
#
# Env vars:
#   FLY_APP        Fly app name (default: ark-arkd). Image is tagged
#                  registry.fly.io/<FLY_APP>:<TAG>.
#   TAG            Image tag (default: latest).
#   FLY_API_TOKEN  Required for the push step. `flyctl auth docker` uses
#                  this token to issue Docker credentials for registry.fly.io.
#                  Create one via `fly tokens create deploy`.
#   SKIP_PUSH      When set to "1", builds locally but skips auth + push.
#                  Useful for smoke-testing the Dockerfile without Fly creds.
#
# The script uses `.infra/.dockerignore.fly` as the dockerignore for this
# build. `docker build` only honours `.dockerignore` at the context root,
# so we copy it into place for the duration of the build and restore the
# original on exit (via trap) -- atomic from the operator's perspective.

set -euo pipefail

FLY_APP="${FLY_APP:-ark-arkd}"
TAG="${TAG:-latest}"
SKIP_PUSH="${SKIP_PUSH:-0}"

# Resolve repo root from the script location so the command works from
# any cwd. `realpath`/`readlink -f` is not portable (macOS ships a BSD
# readlink without -f); cd + pwd is.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DOCKERFILE="$REPO_ROOT/.infra/Dockerfile.fly"
FLY_IGNORE="$REPO_ROOT/.infra/.dockerignore.fly"
ROOT_IGNORE="$REPO_ROOT/.dockerignore"
BACKUP_IGNORE="$REPO_ROOT/.dockerignore.bak.fly-build.$$"

IMAGE="registry.fly.io/${FLY_APP}:${TAG}"

if [ ! -f "$DOCKERFILE" ]; then
  echo "error: $DOCKERFILE not found" >&2
  exit 1
fi
if [ ! -f "$FLY_IGNORE" ]; then
  echo "error: $FLY_IGNORE not found" >&2
  exit 1
fi

# Stage the fly-specific .dockerignore at the context root. `docker build`
# only reads the .dockerignore colocated with the build context -- there is
# no --ignore-file flag. The trap restores the pre-build state even on
# failure / Ctrl-C so a developer's checked-in `.dockerignore` never
# silently drifts.
restore_ignore() {
  if [ -f "$BACKUP_IGNORE" ]; then
    mv -f "$BACKUP_IGNORE" "$ROOT_IGNORE"
  else
    rm -f "$ROOT_IGNORE"
  fi
}
trap restore_ignore EXIT INT TERM

if [ -f "$ROOT_IGNORE" ]; then
  cp -f "$ROOT_IGNORE" "$BACKUP_IGNORE"
fi
cp -f "$FLY_IGNORE" "$ROOT_IGNORE"

echo "==> Building $IMAGE"
echo "    dockerfile : $DOCKERFILE"
echo "    context    : $REPO_ROOT"
echo "    ignorefile : $FLY_IGNORE (staged as $ROOT_IGNORE)"

# BuildKit gives us better caching + smaller build logs. It's on by default
# in Docker Desktop but export anyway for older CLIs / Linux hosts.
export DOCKER_BUILDKIT=1

docker build \
  -f "$DOCKERFILE" \
  -t "$IMAGE" \
  "$REPO_ROOT"

if [ "$SKIP_PUSH" = "1" ]; then
  echo "==> SKIP_PUSH=1 -- not authenticating or pushing"
  echo "    Built local image: $IMAGE"
  exit 0
fi

if [ -z "${FLY_API_TOKEN:-}" ]; then
  echo "error: FLY_API_TOKEN is not set. Push requires a token." >&2
  echo "       Create one with: fly tokens create deploy" >&2
  echo "       Or re-run with SKIP_PUSH=1 to build without pushing." >&2
  exit 2
fi

if ! command -v flyctl >/dev/null 2>&1; then
  echo "error: flyctl not found on PATH. Install from https://fly.io/docs/flyctl/install/" >&2
  exit 3
fi

echo "==> Authenticating Docker against registry.fly.io via flyctl"
# `flyctl auth docker` reads FLY_API_TOKEN from env and writes docker creds
# to ~/.docker/config.json scoped to registry.fly.io.
flyctl auth docker

echo "==> Pushing $IMAGE"
docker push "$IMAGE"

echo ""
echo "Pushed: $IMAGE"
echo ""
echo "This is the default image for FlyMachinesCompute when TAG=latest."
echo "Sessions dispatched with --compute fly-machines will pull this image."
