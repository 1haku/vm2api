#!/bin/sh
# Check the backup time before use: this archives post-backup writes, then restores.
set -eu
ROOT=/home/yibocho/vm2api
BACKUP=$(realpath "${1:?Supply the backup directory}")
case "$BACKUP" in "$ROOT"/backups/*) ;; *) echo 'Unexpected backup directory' >&2; exit 1;; esac
test -f "$BACKUP/stopped-data/kin.db"
test -f "$BACKUP/previous-image.txt"
IMAGE=$(cat "$BACKUP/previous-image.txt")
docker image inspect "$IMAGE" >/dev/null
cd "$ROOT"
docker compose stop vm2api
ARCHIVE="$BACKUP/failed-state-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$ARCHIVE"
docker run --rm --entrypoint sh -v "$ROOT/data:/live" -v "$BACKUP:/backup:ro" -v "$ARCHIVE:/archive" "$IMAGE" -c 'set -e; for file in kin.db kin.db-wal kin.db-shm; do if [ -f "/live/$file" ]; then mv "/live/$file" "/archive/$file"; fi; if [ -f "/backup/stopped-data/$file" ]; then cp "/backup/stopped-data/$file" "/live/$file"; fi; done'
docker run --rm --entrypoint sh -v "$ROOT/src/config:/restore/src/config" -v "$BACKUP:/backup:ro" "$IMAGE" -c 'tar -xzf /backup/config.tar.gz -C /restore'
if [ -f "$BACKUP/docker-compose.override.yml" ]; then cp "$BACKUP/docker-compose.override.yml" "$ROOT/";
else printf 'services:\n  vm2api:\n    image: %s\n' "$IMAGE" > "$ROOT/docker-compose.override.yml"; fi
docker compose up -d --no-deps --pull never vm2api
printf 'Restored %s; replaced database archived at %s\n' "$IMAGE" "$ARCHIVE"
