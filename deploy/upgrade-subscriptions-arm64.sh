#!/bin/sh
# Run from a committed release beneath the existing ARM64 deployment's releases/.
set -eu
ROOT=${VM2API_DEPLOY_ROOT:-/opt/vm2api}
RELEASE=$(pwd -P)
case "$RELEASE" in "$ROOT"/releases/subscriptions-*) ;; *) echo 'Unexpected release directory' >&2; exit 1;; esac
test -f "$ROOT/.env" && test -f "$ROOT/docker-compose.yml"
mkdir -p "$ROOT/deploy" "$ROOT/backups"
chmod 700 "$ROOT/backups"
exec 9>"$ROOT/deploy/.release.lock"
flock -n 9 || { echo 'Another deployment is running' >&2; exit 1; }
REVISION=$(cat CUSTOM_REVISION)
case "$REVISION" in *[!0-9a-f]*|'') exit 1;; esac
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
IMAGE="vm2api-subscriptions-arm64:$STAMP"
BACKUP="$ROOT/backups/$STAMP"
sh deploy/build-subscriptions-arm64.sh "$IMAGE"
mkdir -p "$BACKUP/migration-check" "$BACKUP/stopped-data"
chmod 700 "$BACKUP"
docker inspect vm2api --format '{{.Config.Image}}' > "$BACKUP/previous-image.txt"
cp "$ROOT/.env" "$ROOT/docker-compose.yml" "$BACKUP/"
docker exec vm2api tar -C /opt/vm2api -czf - src/config > "$BACKUP/config.tar.gz"
docker exec -i vm2api node --input-type=module - "$STAMP" <<'NODE'
import {DatabaseSync} from 'node:sqlite'
const db=new DatabaseSync(process.env.KIN_DB_PATH||'/opt/vm2api/data/kin.db')
db.prepare('VACUUM INTO ?').run(`/opt/vm2api/data/pre-upgrade-${process.argv[2]}.db`)
db.close()
NODE
docker cp "vm2api:/opt/vm2api/data/pre-upgrade-$STAMP.db" "$BACKUP/kin.db"
docker exec vm2api rm "/opt/vm2api/data/pre-upgrade-$STAMP.db"
cp "$BACKUP/kin.db" "$BACKUP/migration-check/kin.db"
docker run --rm --network none --entrypoint node -v "$BACKUP/migration-check:/check" "$IMAGE" scripts/check-subscriptions-upgrade.mjs /check/kin.db > "$BACKUP/migration-check.json"
rm -f "$BACKUP/migration-check/kin.db" "$BACKUP/migration-check/kin.db-wal" "$BACKUP/migration-check/kin.db-shm"
cd "$ROOT"
python3 - "$ROOT" "$IMAGE" "$BACKUP" <<'PY'
from pathlib import Path
import os,re,sys
root=Path(sys.argv[1]); image=sys.argv[2]
assert root.resolve()==root and re.fullmatch(r'vm2api-subscriptions-arm64:\d{8}T\d{6}Z',image)
file=root/'.env'; text=file.read_text(); stat=file.stat()
text,n=re.subn(r'^VM2API_SUBSCRIPTIONS_IMAGE=.*$', 'VM2API_SUBSCRIPTIONS_IMAGE='+image, text, flags=re.M)
assert n==1,'Expected exactly one managed image variable'
tmp=Path(sys.argv[3])/'next.env'; tmp.write_text(text); os.chmod(tmp,stat.st_mode&0o777);os.chown(tmp,stat.st_uid,stat.st_gid)
PY
docker compose stop vm2api
tar -czf "$BACKUP/vms.tar.gz" --exclude='*/run' --exclude='*/cli-home/.kin' --exclude='*/cli-home/.cache' --exclude='*.log' vms
for file in kin.db kin.db-wal kin.db-shm; do
  if [ -f "$ROOT/data/$file" ]; then cp "$ROOT/data/$file" "$BACKUP/stopped-data/$file"; fi
done
test -s "$BACKUP/stopped-data/kin.db"
chmod 600 "$BACKUP/.env" "$BACKUP/kin.db" "$BACKUP/vms.tar.gz" "$BACKUP/config.tar.gz"
mv "$BACKUP/next.env" "$ROOT/.env"
if ! docker compose up -d --no-build --no-deps --pull never vm2api; then
  echo "Startup failed. Preserve live data; rollback materials: $BACKUP" >&2; exit 1
fi
ready=0
for n in $(seq 1 120); do
  if docker exec vm2api node --input-type=module -e 'const r=await fetch("http://127.0.0.1:"+(process.env.PORT||8788)+"/healthz",{signal:AbortSignal.timeout(2000)});if(!r.ok)process.exit(1)' >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
test "$ready" = 1
docker exec vm2api node scripts/verify-subscriptions-release.mjs "$REVISION"
python3 - "$ROOT" "$RELEASE" "$IMAGE" <<'PY'
import importlib.util,json,subprocess,sys
from pathlib import Path
root,release,image=Path(sys.argv[1]),Path(sys.argv[2]),sys.argv[3]
script=release/'deploy/subscriptions-retention.py'
spec=importlib.util.spec_from_file_location('retention',script);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
complete=[p for p in (root/'backups').iterdir() if module.STAMP.fullmatch(p.name) and module.recoverable(root,p)]
if len(complete)>=3:
    subprocess.run(['python3',str(script),'--root',str(root),'--active-release',str(release),'--expected-image',image,'--apply','--lock-fd','9'],check=True,pass_fds=(9,))
else:
    report={'applied':False,'keep':3,'recoverableBackups':len(complete),'reason':'Fewer than three backups; all retained'}
    (root/'deploy/retention-last.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report))
PY
printf 'IMAGE=%s\nBACKUP=%s\nRELEASE=%s\n' "$IMAGE" "$BACKUP" "$RELEASE"
