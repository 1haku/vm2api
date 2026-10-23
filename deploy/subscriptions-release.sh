#!/bin/sh
# Run from a committed release archive; touches only the vm2api control plane.
set -eu
ROOT=/home/yibocho/vm2api
mkdir -p "$ROOT/deploy"
exec 9>"$ROOT/deploy/.release.lock"
flock -n 9 || { echo 'Another release or retention operation is running' >&2; exit 1; }
RELEASE=$(pwd -P)
case "$RELEASE" in "$ROOT"/releases/subscriptions-*) ;; *) echo 'Unexpected release directory' >&2; exit 1;; esac
REVISION=$(cat CUSTOM_REVISION)
case "$REVISION" in *[!0-9a-f]*|'') echo 'Invalid release revision' >&2; exit 1;; esac
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
IMAGE="vm2api-subscriptions:$STAMP"
BACKUP="$ROOT/backups/$STAMP"
# Build and test Go before interrupting the running service.
# An optional local Node image may contain /payload recovered from a previous
# release. fetch-payload still checks every pinned size/hash; mismatches cannot
# enter the final image. Default builds continue to download from upstream.
docker build --build-arg "CUSTOM_REVISION=$REVISION" --build-arg "PAYLOAD_BASE_IMAGE=${VM2API_PAYLOAD_BASE_IMAGE:-node:22-bookworm-slim}" -f deploy/Dockerfile.subscriptions -t "$IMAGE" .
docker run --rm --network none --entrypoint node "$IMAGE" scripts/verify-computer-payload.mjs --install-image
docker run --rm --network none --entrypoint python3 -v "$RELEASE/deploy:/opt/vm2api/deploy:ro" -v "$RELEASE/test/deploy:/opt/vm2api/test/deploy:ro" "$IMAGE" -m unittest discover -s test/deploy -v

# Validate the shipped CLI profile on a loopback upstream before the full suite.
# The baseline is a read-only public binary, never production credentials/data.
docker run --rm --entrypoint node -e KIN_303_KERNEL=/opt/vm2api/image-wrap-cli/kin-kernel -e KIN_303_CLI=/opt/vm2api/image-wrap-cli/cli-node -e KIN_303_BASE_CLI=/opt/vm2api/test-baseline-cli -v "$ROOT/share/wrap-cli/cli-node:/opt/vm2api/test-baseline-cli:ro" -v "$RELEASE/test:/opt/vm2api/test:ro" "$IMAGE" --test test/e2e/official-303.e2e.test.mjs
docker run --rm --entrypoint node -v "$ROOT/share/wrap-cli/cli-node:/opt/vm2api/test-baseline-cli:ro" -v "$RELEASE/test:/opt/vm2api/test:ro" -v "$RELEASE/web/src:/opt/vm2api/web/src:ro" -v "$RELEASE/web/vite.config.ts:/opt/vm2api/web/vite.config.ts:ro" -v "$RELEASE/docker-compose.yml:/opt/vm2api/docker-compose.yml:ro" -v "$RELEASE/Dockerfile:/opt/vm2api/Dockerfile:ro" -v "$RELEASE/deploy/Dockerfile.arm64-control:/opt/vm2api/deploy/Dockerfile.arm64-control:ro" -v "$RELEASE/deploy/Dockerfile.subscriptions:/opt/vm2api/deploy/Dockerfile.subscriptions:ro" "$IMAGE" scripts/test-subscriptions-release.mjs
mkdir -p "$BACKUP/migration-check"
chmod 700 "$BACKUP"
docker inspect vm2api --format '{{.Config.Image}}' > "$BACKUP/previous-image.txt"
cp "$ROOT/docker-compose.yml" "$ROOT/.env" "$BACKUP/"
if [ -f "$ROOT/docker-compose.override.yml" ]; then cp "$ROOT/docker-compose.override.yml" "$BACKUP/"; fi
docker exec vm2api tar -C /opt/vm2api -czf - src/config > "$BACKUP/config.tar.gz"
docker exec -i vm2api node --input-type=module - "$STAMP" <<'NODE'
import {DatabaseSync} from 'node:sqlite'
const db=new DatabaseSync(process.env.KIN_DB_PATH||'/opt/vm2api/data/kin.db')
db.prepare('VACUUM INTO ?').run(`/opt/vm2api/data/pre-subscriptions-${process.argv[2]}.db`)
db.close()
NODE
docker cp "vm2api:/opt/vm2api/data/pre-subscriptions-$STAMP.db" "$BACKUP/kin.db"
docker exec vm2api rm "/opt/vm2api/data/pre-subscriptions-$STAMP.db"
cp "$BACKUP/kin.db" "$BACKUP/migration-check/kin.db"
docker run --rm --entrypoint node -v "$BACKUP/migration-check:/migration-check" "$IMAGE" scripts/check-subscriptions-upgrade.mjs /migration-check/kin.db > "$BACKUP/migration-check.json"
# Validation succeeded. Keep the original snapshot/report and the stopped backup,
# not a third, disposable migrated database copy on every release.
rm -f "$BACKUP/migration-check/kin.db" "$BACKUP/migration-check/kin.db-wal" "$BACKUP/migration-check/kin.db-shm"
# Capture the exact stopped DB and WAL before its schema changes.
cd "$ROOT"
sha256sum "$ROOT/vms/active.json" > "$BACKUP/active-before.sha256"
docker compose stop vm2api
# Back up persistent slot records after stopping the control plane; runtime
# sockets and logs can keep changing while the slot containers are running.
docker run --rm --entrypoint sh -v "$ROOT/vms:/vms:ro" "$IMAGE" -c 'cd /; tar -czf - vms/*.json' > "$BACKUP/vms.tar.gz"
chmod 600 "$BACKUP/vms.tar.gz"
mkdir -p "$BACKUP/stopped-data"
docker run --rm --entrypoint sh -v "$ROOT/data:/live:ro" -v "$BACKUP/stopped-data:/backup" "$IMAGE" -c 'for file in kin.db kin.db-wal kin.db-shm; do if [ -f "/live/$file" ]; then cp "/live/$file" "/backup/$file"; fi; done; test -f /backup/kin.db'
printf 'services:\n  vm2api:\n    image: %s\n' "$IMAGE" > "$ROOT/docker-compose.override.yml"
if ! docker compose up -d --no-deps --pull never vm2api; then
  echo "Start failed; use sh $RELEASE/deploy/subscriptions-rollback.sh $BACKUP" >&2
  exit 1
fi
ready=0
for attempt in $(seq 1 120); do
  if docker exec vm2api node --input-type=module -e 'const r=await fetch("http://127.0.0.1:"+(process.env.PORT||8787)+"/health",{signal:AbortSignal.timeout(2000)});if(!r.ok)process.exit(1)' >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != 1 ]; then echo "Health check failed; rollback backup: $BACKUP" >&2; exit 1; fi
docker exec vm2api node scripts/verify-subscriptions-release.mjs "$REVISION"
python3 "$RELEASE/deploy/subscriptions-retention.py" --root "$ROOT" --active-release "$RELEASE" --expected-image "$IMAGE" --apply --lock-fd 9
printf 'IMAGE=%s\nBACKUP=%s\nRELEASE=%s\n' "$IMAGE" "$BACKUP" "$RELEASE"
