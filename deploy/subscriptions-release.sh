#!/bin/sh
# Run from the uploaded release directory on the Ubuntu host.
set -eu
ROOT=/home/yibocho/vm2api
RELEASE=$(pwd -P)
case "$RELEASE" in "$ROOT"/releases/subscriptions-*) ;; *) echo 'Unexpected release directory' >&2; exit 1;; esac
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
IMAGE="vm2api-subscriptions:$STAMP"
BACKUP="$ROOT/backups/$STAMP"
mkdir -p "$BACKUP"
chmod 700 "$BACKUP"
docker inspect vm2api --format '{{.Config.Image}}' > "$BACKUP/previous-image.txt"
cp "$ROOT/docker-compose.yml" "$ROOT/.env" "$BACKUP/"
if [ -f "$ROOT/docker-compose.override.yml" ]; then cp "$ROOT/docker-compose.override.yml" "$BACKUP/"; fi
docker exec -i vm2api node --input-type=module - "$STAMP" <<'NODE'
import {DatabaseSync} from 'node:sqlite'
const db=new DatabaseSync(process.env.KIN_DB_PATH||'/opt/vm2api/data/kin.db')
db.prepare('VACUUM INTO ?').run(`/opt/vm2api/data/pre-subscriptions-${process.argv[2]}.db`)
db.close()
NODE
docker cp "vm2api:/opt/vm2api/data/pre-subscriptions-$STAMP.db" "$BACKUP/kin.db"
docker exec vm2api rm "/opt/vm2api/data/pre-subscriptions-$STAMP.db"
docker exec vm2api tar -C /opt/vm2api -czf - src/config > "$BACKUP/config.tar.gz"
REVISION=$(cat CUSTOM_REVISION 2>/dev/null || printf unknown)
docker build --build-arg "CUSTOM_REVISION=$REVISION" -f deploy/Dockerfile.subscriptions -t "$IMAGE" .
# Exercise the exact deployed database upgrade on a copy before touching production.
mkdir -p "$BACKUP/migration-check"
cp "$BACKUP/kin.db" "$BACKUP/migration-check/kin.db"
docker run --rm --entrypoint node -v "$BACKUP/migration-check:/migration-check" "$IMAGE" --input-type=module -e '
import {createDatabase} from "/opt/vm2api/src/lib/db/database.mjs";
import {DatabaseSync} from "node:sqlite";
const beforeDb=new DatabaseSync("/migration-check/kin.db");
const counts=db=>Object.fromEntries(["users","groups","subscription_slots","user_subscriptions","subscription_ledger","usage_logs"].map(t=>[t,db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
const before=counts(beforeDb);beforeDb.close();
const db=createDatabase({dataDir:"/migration-check"});
const check=db.prepare("PRAGMA quick_check").get();
if(check.quick_check!=="ok")throw new Error("Migration integrity check failed");
if(JSON.stringify(before)!==JSON.stringify(counts(db)))throw new Error("Migration changed business row counts");
if(!db.prepare("SELECT version FROM custom_schema_migrations WHERE version=?").get("001"))throw new Error("Custom migration missing");
console.log("Database migration preflight passed",{integrity:check.quick_check,counts:before});
db.close();'
printf 'services:\n  vm2api:\n    image: %s\n' "$IMAGE" > "$ROOT/docker-compose.override.yml"
cd "$ROOT"
docker compose up -d --no-deps --pull never vm2api
printf 'IMAGE=%s\nBACKUP=%s\nRELEASE=%s\n' "$IMAGE" "$BACKUP" "$RELEASE"
