#!/bin/sh
set -eu

ROOT="${KIN_PROJECT_ROOT:-/opt/vm2api}"
IMAGE_BIN="/opt/vm2api/image-bin"
mkdir -p "$ROOT/vms" "$ROOT/data" "$ROOT/bin"

if [ ! -f "$ROOT/vms/active.json" ]; then
  printf '%s\n' '{ "active_vm": "vm-01" }' > "$ROOT/vms/active.json"
fi
if [ ! -f "$ROOT/vms/vm-01.json" ]; then
  cat > "$ROOT/vms/vm-01.json" <<'EOF'
{
  "id": "vm-01",
  "name": "vm-01",
  "status": "stopped",
  "schedulable": false,
  "policy": { "maxConcurrency": 2 }
}
EOF
fi

ensure_bin() {
  name="$1"
  dest="$ROOT/bin/$name"
  src="$IMAGE_BIN/$name"
  if [ ! -f "$src" ]; then
    if [ -f "$dest" ]; then
      chmod 755 "$dest" || true
    fi
    return 0
  fi
  tmp="$dest.new"
  cp "$src" "$tmp"
  chmod 755 "$tmp"
  mv -f "$tmp" "$dest"
}
ensure_bin kin-kernel
ensure_bin kin-egress
ensure_bin kin-worker
ensure_bin kin-codex-kernel
ensure_bin kin-cookie-auth

KERNEL="${KIN_KERNEL_BIN:-$ROOT/bin/kin-kernel}"
if [ ! -x "$KERNEL" ]; then
  echo "vm2api: $KERNEL missing or not executable after image-bin copy. Rebuild with docker compose build, or put linux amd64 Release files in $ROOT/bin." >&2
  exit 1
fi
mkdir -p "$ROOT/share"
if [ -d /opt/vm2api/image-wrap-cli ] && [ ! -f "$ROOT/share/wrap-cli/bun" ]; then
  rm -rf "$ROOT/share/wrap-cli"
  cp -a /opt/vm2api/image-wrap-cli "$ROOT/share/wrap-cli"
fi

if [ ! -S /var/run/docker.sock ]; then
  echo "vm2api: /var/run/docker.sock not mounted; slot create/start will fail." >&2
elif [ -f /opt/vm2api/docker/kin-os/build.mjs ]; then
  node /opt/vm2api/docker/kin-os/build.mjs ubuntu
fi

env_get_file() {
  name="$1"
  file="$2"
  [ -f "$file" ] || return 0
  grep -E "^${name}=" "$file" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d "'" | tr -d '"' | tr -d '\r'
}

env_upsert_if_empty() {
  name="$1"
  value="$2"
  file="$3"
  [ -n "$file" ] || return 0
  if [ -f "$file" ]; then
    current="$(env_get_file "$name" "$file")"
    if [ -n "$current" ]; then
      return 0
    fi
    if grep -qE "^${name}=" "$file"; then
      sed -i "s|^${name}=.*|${name}=${value}|" "$file"
    else
      printf '%s=%s\n' "$name" "$value" >>"$file"
    fi
  fi
}

rand_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    python3 -c 'import secrets; print(secrets.token_hex(32))'
  fi
}

ENVF="${ROOT}/.env"
if [ -z "${VM2API_ADMIN_USER:-}" ]; then
  VM2API_ADMIN_USER=admin
  export VM2API_ADMIN_USER
  env_upsert_if_empty VM2API_ADMIN_USER admin "$ENVF"
fi
if [ -z "${VM2API_ADMIN_PASSWORD:-}" ]; then
  VM2API_ADMIN_PASSWORD=123456
  export VM2API_ADMIN_PASSWORD
  env_upsert_if_empty VM2API_ADMIN_PASSWORD 123456 "$ENVF"
  echo "vm2api: VM2API_ADMIN_PASSWORD was empty; using default admin / 123456 (change after login)." >&2
fi
if [ -z "${VM2API_API_KEY:-}" ] && [ -z "${KIN_API_KEY:-}" ]; then
  VM2API_API_KEY="$(rand_hex)"
  export VM2API_API_KEY
  env_upsert_if_empty VM2API_API_KEY "$VM2API_API_KEY" "$ENVF"
  echo "vm2api: generated VM2API_API_KEY (empty in env)." >&2
fi
if [ -z "${VM2API_DB_SECRET:-}" ] && [ -z "${KIN_DB_SECRET:-}" ]; then
  VM2API_DB_SECRET="$(rand_hex)"
  export VM2API_DB_SECRET
  env_upsert_if_empty VM2API_DB_SECRET "$VM2API_DB_SECRET" "$ENVF"
fi

cd /opt/vm2api
exec node src/server.mjs
