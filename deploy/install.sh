#!/usr/bin/env bash
#
# vm2api 一键安装 / 更新
# 参考 sub2api deploy/install.sh 与 CLIProxyAPI installer：
#   查 GitHub Release → 停服务 → 换版本 → 保留配置 → 拉起。
#
# 安装:
#   curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash
# 更新:
#   curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade
# 检查:
#   sudo bash /opt/vm2api/deploy/install.sh check
#
set -euo pipefail

if [ -z "${BASH_VERSION:-}" ]; then
  echo "请用 bash 运行（需要 bash 4+）" >&2
  exit 1
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

GITHUB_REPO="${VM2API_GITHUB_REPO:-dofastted/vm2api}"
INSTALL_DIR="${VM2API_DIR:-/opt/vm2api}"
SERVICE_NAME="vm2api"
DEFAULT_PORT="${PORT:-8787}"
TARGET_VERSION=""
ASSUME_YES=0
NO_START=0
SYNC_WRAP=0

info() { echo -e "${BLUE}[信息]${NC} $*"; }
ok() { echo -e "${GREEN}[成功]${NC} $*"; }
warn() { echo -e "${YELLOW}[警告]${NC} $*"; }
err() { echo -e "${RED}[错误]${NC} $*" >&2; }

is_interactive() {
  [ -e /dev/tty ] && [ -r /dev/tty ] && [ -w /dev/tty ]
}

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    err "请用 root 运行：curl ... | sudo bash   或   sudo bash deploy/install.sh $*"
    exit 1
  fi
}

usage() {
  cat <<EOF
用法: $(basename "$0") [命令] [选项]

命令:
  install              安装到 ${INSTALL_DIR}（默认）
  upgrade | update     升到最新 GitHub Release（保留 .env / vms / data）
  check                对比当前版本与最新 Release，打印 changelog
  changelog            打印本地 CHANGELOG.md
  status               当前版本、容器、探活
  uninstall            停控制面（默认保留 .env / vms / data）

选项:
  --version vX.Y.Z     指定 tag
  --dir PATH           安装目录（默认 ${INSTALL_DIR}）
  --yes                非交互
  --no-start           只拉代码，不 compose up
  --sync-wrap          升级后若 changelog 提到 wrap-cli/sync 则自动同步槽内 CLI
  -h, --help           帮助
EOF
}

normalize_tag() {
  local v="${1:-}"
  v="${v#v}"
  if [ -z "$v" ]; then
    echo ""
    return
  fi
  echo "v${v}"
}

version_of_tag() {
  echo "${1#v}"
}

semver_ge() {
  # return 0 if $1 >= $2
  python3 - "$1" "$2" <<'PY' 2>/dev/null || true
import sys
def p(v):
    v = v[1:] if v.startswith("v") else v
    parts = []
    for x in v.split("."):
        try:
            parts.append(int(x))
        except ValueError:
            parts.append(0)
    parts += [0] * (3 - len(parts))
    return tuple(parts[:3])
a, b = sys.argv[1], sys.argv[2]
sys.exit(0 if p(a) >= p(b) else 1)
PY
}

semver_ge() {
  # return 0 if $1 >= $2
  python3 - "$1" "$2" <<'PY' 2>/dev/null || true
import sys
def p(v):
    v = v[1:] if v.startswith("v") else v
    parts = []
    for x in v.split("."):
        try:
            parts.append(int(x))
        except ValueError:
            parts.append(0)
    parts += [0] * (3 - len(parts))
    return tuple(parts[:3])
a, b = sys.argv[1], sys.argv[2]
sys.exit(0 if p(a) >= p(b) else 1)
PY
}

local_version() {
  if [ -f "${INSTALL_DIR}/VERSION" ]; then
    tr -d '[:space:]' <"${INSTALL_DIR}/VERSION"
    return
  fi
  echo "not_installed"
}

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    err "需要 Docker Compose（docker compose 或 docker-compose）"
    exit 1
  fi
}

require_cmds() {
  local missing=()
  for c in git curl docker; do
    command -v "$c" >/dev/null 2>&1 || missing+=("$c")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    err "缺少依赖: ${missing[*]}"
    info "Ubuntu: apt-get update && apt-get install -y git curl ca-certificates docker.io"
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    err "Docker 未运行，或当前用户不能访问 docker.sock"
    exit 1
  fi
  compose version >/dev/null
}

github_api() {
  local url="$1"
  local args=(-fsSL --connect-timeout 10 --max-time 30
    -H "Accept: application/vnd.github+json"
    -H "User-Agent: vm2api-installer"
    -H "X-GitHub-Api-Version: 2022-11-28")
  if [ -n "${GITHUB_TOKEN:-}${VM2API_GITHUB_TOKEN:-}" ]; then
    args+=(-H "Authorization: Bearer ${GITHUB_TOKEN:-$VM2API_GITHUB_TOKEN}")
  fi
  curl "${args[@]}" "$url"
}

latest_release_tag() {
  local json tag
  json="$(github_api "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" 2>/dev/null || true)"
  tag="$(printf '%s' "$json" | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  if [ -n "$tag" ]; then
    normalize_tag "$tag"
    return
  fi
  tag="$(git ls-remote --tags --refs "https://github.com/${GITHUB_REPO}.git" 2>/dev/null \
    | awk -F/ '{print $NF}' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1,1 -k2,2n -k3,3n | tail -n1 || true)"
  if [ -z "$tag" ]; then
    err "拿不到 GitHub 最新 Release。可设 GITHUB_TOKEN，或指定 --version vX.Y.Z"
    exit 1
  fi
  echo "$tag"
}

release_notes() {
  local tag="$1"
  github_api "https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${tag}" 2>/dev/null \
    | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
    print((d.get("body") or "").strip())
except Exception:
    pass' 2>/dev/null || true
}

print_changelog_slice() {
  local file="$1"
  local from_ver="$2"
  local to_ver="$3"
  if [ ! -f "$file" ]; then
    return
  fi
  python3 - "$file" "$from_ver" "$to_ver" <<'PY'
import re, sys
path, current, target = sys.argv[1], sys.argv[2].lstrip("v"), sys.argv[3].lstrip("v")
text = open(path, encoding="utf-8").read()
chunks = re.split(r"^## ", text, flags=re.M)[1:]
def ver(h):
    m = re.match(r"v?(\d+\.\d+\.\d+)", h)
    return m.group(1) if m else None
def tup(v):
    if not v: return (0,0,0)
    return tuple(int(x) for x in v.split(".")[:3])
cur, tgt = tup(current), tup(target)
shown = 0
for chunk in chunks:
    heading, _, body = chunk.partition("\n")
    heading = heading.strip()
    v = ver(heading)
    if not v or v == "unreleased":
        continue
    tv = tup(v)
    if tv > cur and tv <= tgt:
        print(f"## {heading.strip()}")
        print(body.strip())
        print()
        shown += 1
if shown == 0:
    sys.exit(0)
PY
}

needs_wrap_sync() {
  local file="$1"
  local from_ver="$2"
  local to_ver="$3"
  print_changelog_slice "$file" "$from_ver" "$to_ver" | grep -q 'wrap-cli/sync'
}

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return
  fi
  python3 -c 'import secrets; print(secrets.token_hex(32))'
}

ensure_env() {
  local envf="${INSTALL_DIR}/.env"
  if [ -f "$envf" ]; then
    chmod 600 "$envf" || true
    info "保留已有 .env"
    return
  fi
  local example="${INSTALL_DIR}/.env.example"
  if [ ! -f "$example" ]; then
    err "没有 .env.example，无法生成 .env"
    exit 1
  fi
  cp "$example" "$envf"
  local key admin secret
  key="$(gen_secret)"
  admin="$(gen_secret)"
  secret="$(gen_secret)"
  if command -v sed >/dev/null 2>&1; then
    sed -i -e "s|^VM2API_API_KEY=.*|VM2API_API_KEY=${key}|" \
      -e "s|^VM2API_ADMIN_PASSWORD=.*|VM2API_ADMIN_PASSWORD=${admin}|" \
      -e "s|^VM2API_DB_SECRET=.*|VM2API_DB_SECRET=${secret}|" "$envf"
  fi
  chmod 600 "$envf"
  ok "已写 ${envf}（chmod 600），请记住管理台密码（VM2API_ADMIN_PASSWORD）"
}

wait_health() {
  local port url i
  port="$(grep -E '^PORT=' "${INSTALL_DIR}/.env" 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
  port="${port:-$DEFAULT_PORT}"
  url="http://127.0.0.1:${port}/health"
  info "等待控制面 ${url}"
  for i in $(seq 1 45); do
    if curl -fsS --noproxy '*' "$url" >/dev/null 2>&1; then
      ok "探活通过"
      return 0
    fi
    sleep 2
  done
  warn "探活超时。看日志: docker logs ${SERVICE_NAME}"
  return 1
}

read_env_key() {
  local name="$1"
  grep -E "^${name}=" "${INSTALL_DIR}/.env" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d "'" | tr -d '"'
}

sync_wrap_cli() {
  local key port
  key="$(read_env_key VM2API_API_KEY)"
  port="$(read_env_key PORT)"
  port="${port:-$DEFAULT_PORT}"
  if [ -z "$key" ]; then
    warn "没有 VM2API_API_KEY，跳过 wrap-cli/sync。可稍后："
    echo "  curl -sS -X POST http://127.0.0.1:${port}/api/panel/wrap-cli/sync -H \"Authorization: Bearer \$VM2API_API_KEY\" -H 'Content-Type: application/json' -d '{\"restart\":true}'"
    return 0
  fi
  info "同步槽内 wrap CLI / kernel"
  curl -fsS -X POST "http://127.0.0.1:${port}/api/panel/wrap-cli/sync" \
    -H "Authorization: Bearer ${key}" \
    -H "Content-Type: application/json" \
    -d '{"restart":true}' >/dev/null
  ok "wrap-cli/sync 已提交"
}

checkout_tag() {
  local tag="$1"
  cd "${INSTALL_DIR}"
  if [ ! -d .git ]; then
    err "${INSTALL_DIR} 不是 git 仓库。请重新安装，或手动 git clone。"
    exit 1
  fi
  info "fetch tags"
  git fetch --tags origin
  if ! git rev-parse -q --verify "refs/tags/${tag}" >/dev/null && \
     ! git rev-parse -q --verify "origin/${tag}" >/dev/null && \
     ! git cat-file -t "${tag}" >/dev/null 2>&1; then
    # fetch may have created the tag
    if ! git ls-remote --tags origin "refs/tags/${tag}" | grep -q .; then
      err "找不到 tag ${tag}"
      exit 1
    fi
  fi
  info "checkout ${tag}（不碰 .env / vms / data）"
  git checkout -f "${tag}"
  chmod 755 bin/kin-* 2>/dev/null || true
}

fresh_clone() {
  local tag="$1"
  if [ -d "${INSTALL_DIR}/.git" ]; then
    info "已有仓库，改为升级路径"
    checkout_tag "$tag"
    return
  fi
  if [ -e "${INSTALL_DIR}" ] && [ -n "$(ls -A "${INSTALL_DIR}" 2>/dev/null || true)" ]; then
    err "${INSTALL_DIR} 已存在且不是 git 仓库"
    exit 1
  fi
  info "clone ${GITHUB_REPO} → ${INSTALL_DIR}"
  git clone --branch "$tag" --depth 1 "https://github.com/${GITHUB_REPO}.git" "${INSTALL_DIR}" \
    || git clone "https://github.com/${GITHUB_REPO}.git" "${INSTALL_DIR}"
  cd "${INSTALL_DIR}"
  git fetch --tags origin
  git checkout -f "$tag"
  chmod 755 bin/kin-* 2>/dev/null || true
}

start_stack() {
  if [ "$NO_START" = 1 ]; then
    warn "--no-start：跳过 compose up"
    return
  fi
  cd "${INSTALL_DIR}"
  info "docker compose up -d --build（只重建控制面，不 docker rm 槽）"
  compose up -d --build
  wait_health || true
}

print_banner() {
  echo ""
  echo -e "${CYAN}==============================================${NC}"
  echo -e "${CYAN}  vm2api${NC}"
  echo -e "${CYAN}==============================================${NC}"
}

cmd_install() {
  need_root
  require_cmds
  print_banner
  local tag
  tag="${TARGET_VERSION:-$(latest_release_tag)}"
  tag="$(normalize_tag "$tag")"
  info "目标版本 ${tag}"
  fresh_clone "$tag"
  ensure_env
  start_stack
  ok "安装完成  ${INSTALL_DIR}  @ $(local_version)"
  echo ""
  info "管理台: http://127.0.0.1:${DEFAULT_PORT}/console"
  info "探活:   curl -sS --noproxy '*' http://127.0.0.1:${DEFAULT_PORT}/health"
  info "以后更新: curl -sSL https://raw.githubusercontent.com/${GITHUB_REPO}/main/deploy/install.sh | sudo bash -s -- upgrade"
}

cmd_upgrade() {
  need_root
  require_cmds
  print_banner
  if [ ! -d "${INSTALL_DIR}/.git" ]; then
    err "未安装。先: curl -sSL https://raw.githubusercontent.com/${GITHUB_REPO}/main/deploy/install.sh | sudo bash"
    exit 1
  fi
  local current tag
  current="$(local_version)"
  tag="${TARGET_VERSION:-$(latest_release_tag)}"
  tag="$(normalize_tag "$tag")"
  info "当前 ${current}  →  目标 ${tag}"
  if [ "v${current}" = "$tag" ] && [ "$ASSUME_YES" = 1 ]; then
    ok "已经是 ${tag}"
    return
  fi
  if [ "v${current}" = "$tag" ]; then
    ok "已经是 ${tag}，仍会重建控制面镜像以对齐仓内文件"
  fi
  checkout_tag "$tag"
  ensure_env
  echo ""
  info "本版 changelog"
  print_changelog_slice "${INSTALL_DIR}/CHANGELOG.md" "$current" "$(version_of_tag "$tag")" || true
  local notes
  notes="$(release_notes "$tag" || true)"
  if [ -n "$notes" ]; then
    echo "$notes"
    echo ""
  fi
  start_stack
  if needs_wrap_sync "${INSTALL_DIR}/CHANGELOG.md" "$current" "$(version_of_tag "$tag")" || [ "$SYNC_WRAP" = 1 ]; then
    if [ "$SYNC_WRAP" = 1 ] || [ "$ASSUME_YES" = 1 ]; then
      sync_wrap_cli || warn "wrap-cli/sync 失败，可稍后在面板重试"
    else
      warn "此跨度需要槽内 wrap CLI / kernel 同步。加 --sync-wrap 或："
      echo "  curl -sS -X POST http://127.0.0.1:${DEFAULT_PORT}/api/panel/wrap-cli/sync \\"
      echo "    -H \"Authorization: Bearer \$VM2API_API_KEY\" -H 'Content-Type: application/json' -d '{\"restart\":true}'"
    fi
  fi
  ok "已更新到 $(local_version)"
}

cmd_check() {
  local current tag
  current="$(local_version)"
  tag="$(latest_release_tag)"
  echo "当前: ${current}"
  echo "最新: ${tag}"
  if [ "v${current}" = "$tag" ]; then
    ok "已是最新"
  else
    warn "有新版本 ${tag}"
    echo ""
    echo "一键更新:"
    echo "  curl -sSL https://raw.githubusercontent.com/${GITHUB_REPO}/main/deploy/install.sh | sudo bash -s -- upgrade"
    echo ""
    if [ -f "${INSTALL_DIR}/CHANGELOG.md" ]; then
      print_changelog_slice "${INSTALL_DIR}/CHANGELOG.md" "$current" "$(version_of_tag "$tag")" || true
    fi
    local notes
    notes="$(release_notes "$tag" || true)"
    if [ -n "$notes" ]; then
      echo "## ${tag} Release notes"
      echo "$notes"
    fi
  fi
}

cmd_changelog() {
  local file="${INSTALL_DIR}/CHANGELOG.md"
  if [ ! -f "$file" ]; then
    file="$(cd "$(dirname "$0")/.." && pwd)/CHANGELOG.md"
  fi
  if [ ! -f "$file" ]; then
    err "找不到 CHANGELOG.md"
    exit 1
  fi
  cat "$file"
}

cmd_status() {
  local current port
  current="$(local_version)"
  echo "目录:    ${INSTALL_DIR}"
  echo "版本:    ${current}"
  if [ -d "${INSTALL_DIR}/.git" ]; then
    echo "git:     $(git -C "${INSTALL_DIR}" describe --tags --always 2>/dev/null || echo unknown)"
  fi
  if command -v docker >/dev/null 2>&1; then
    docker ps --filter "name=${SERVICE_NAME}" --format '容器:    {{.Names}}  {{.Status}}' || true
  fi
  port="$(read_env_key PORT 2>/dev/null || true)"
  port="${port:-$DEFAULT_PORT}"
  if curl -fsS --noproxy '*' "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
    echo "探活:    ok  http://127.0.0.1:${port}/health"
  else
    echo "探活:    down"
  fi
}

cmd_uninstall() {
  need_root
  print_banner
  if [ "$ASSUME_YES" != 1 ] && is_interactive; then
    echo -n "停止并删除控制面容器，保留 .env / vms / data。继续? [y/N] " >/dev/tty
    read -r ans </dev/tty || true
    case "$ans" in
      y|Y|yes|YES) ;;
      *) info "已取消"; exit 0 ;;
    esac
  fi
  if [ -d "${INSTALL_DIR}" ]; then
    (cd "${INSTALL_DIR}" && compose down) || docker rm -f "${SERVICE_NAME}" 2>/dev/null || true
  fi
  ok "控制面已停。数据仍在 ${INSTALL_DIR}/{.env,vms,data}"
  info "若要整目录删除: rm -rf ${INSTALL_DIR}"
}

COMMAND="install"
while [ $# -gt 0 ]; do
  case "$1" in
    install|upgrade|update|check|changelog|status|uninstall)
      COMMAND="$1"
      shift
      ;;
    --version)
      TARGET_VERSION="$(normalize_tag "$2")"
      shift 2
      ;;
    --dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    --yes|-y)
      ASSUME_YES=1
      shift
      ;;
    --no-start)
      NO_START=1
      shift
      ;;
    --sync-wrap)
      SYNC_WRAP=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      err "未知参数: $1"
      usage
      exit 1
      ;;
  esac
done

case "$COMMAND" in
  install) cmd_install ;;
  upgrade|update) cmd_upgrade ;;
  check) cmd_check ;;
  changelog) cmd_changelog ;;
  status) cmd_status ;;
  uninstall) cmd_uninstall ;;
  *) usage; exit 1 ;;
esac
