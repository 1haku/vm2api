#!/bin/sh
# Build and validate the custom image on an ARM64 host, without production mounts.
set -eu
case "$(uname -m)" in aarch64|arm64) ;; *) echo 'An ARM64 build host is required' >&2; exit 1;; esac
ROOT=$(pwd -P)
REVISION=$(cat CUSTOM_REVISION)
case "$REVISION" in *[!0-9a-f]*|'') echo 'Invalid revision' >&2; exit 1;; esac
IMAGE=${1:-vm2api-subscriptions-arm64:$(date -u +%Y%m%dT%H%M%SZ)}
WEB="$IMAGE-web"
HELPERS="$IMAGE-helpers"
BASE="$IMAGE-base"
docker build --platform linux/arm64 --target web -f deploy/Dockerfile.arm64-control -t "$WEB" .
docker run --rm --init --network none --entrypoint sh -v "$ROOT/src:/src/src:ro" "$WEB" -c 'pnpm test && pnpm exec tsc -b'
docker build --platform linux/arm64 --target helpers -f deploy/Dockerfile.arm64-control -t "$HELPERS" .
docker run --rm --init --entrypoint sh -e CGO_ENABLED=1 "$HELPERS" -c 'cd /src/worker && go vet ./... && go test -race ./... && cd /src/api-kernel && go test -race ./...'
docker build --platform linux/arm64 -f deploy/Dockerfile.arm64-control -t "$BASE" .
docker build --platform linux/arm64 --build-arg "CONTROL_IMAGE=$BASE" --build-arg "CUSTOM_REVISION=$REVISION" -f deploy/Dockerfile.subscriptions-arm64 -t "$IMAGE" .
python3 test/deploy/smoke_arm64_image.py "$IMAGE"
docker run --rm --init --network none --entrypoint python3 -v "$ROOT/test:/opt/vm2api/test:ro" "$IMAGE" test/deploy/smoke_native_cli.py
docker run --rm --init --entrypoint node -e KIN_303_KERNEL=/opt/vm2api/image-wrap-cli/kin-kernel -e KIN_303_CLI=/opt/vm2api/image-native-cli/cli-node -v "$ROOT/test:/opt/vm2api/test:ro" "$IMAGE" --test test/e2e/official-303.e2e.test.mjs
docker run --rm --init --entrypoint node -v "$ROOT/test:/opt/vm2api/test:ro" -v "$ROOT/web/src:/opt/vm2api/web/src:ro" -v "$ROOT/web/vite.config.ts:/opt/vm2api/web/vite.config.ts:ro" -v "$ROOT/docker-compose.yml:/opt/vm2api/docker-compose.yml:ro" -v "$ROOT/Dockerfile:/opt/vm2api/Dockerfile:ro" -v "$ROOT/deploy:/opt/vm2api/deploy:ro" "$IMAGE" scripts/test-subscriptions-release.mjs
printf 'IMAGE=%s\nREVISION=%s\n' "$IMAGE" "$REVISION"
