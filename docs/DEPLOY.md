# 部署

推荐 **Docker Compose**。仓库放在 `/opt/vm2api`。

## 机器

Ubuntu 24.04 + Docker Engine。Debian 12 上槽内核常常起不来。

最少三个环境变量，写在仓库 `.env`（`chmod 600`），不要进 git：

```bash
VM2API_API_KEY='很长的随机串'
VM2API_ADMIN_PASSWORD='面板密码'
VM2API_DB_SECRET='再一串'
```

抄本：[deploy/env.example](deploy/env.example)。`VM2API_*` 优先于 `KIN_*`。

## 该看到什么容器

| 容器 | 说明 |
|---|---|
| `vm2api` | 控制面。Compose **只起这一个** |
| `kin-<槽>` | 每个**已启动**的槽 1 个 |
| 没有 | 未启动的槽；同机其它项目的 postgres / newapi 等 |

不是一个父容器里多个子进程。

仓库必须在 `/opt/vm2api`（槽的 `-v` 路径由宿主机 Docker 解释）。挂 `docker.sock`，`network_mode: host`。

## 安装

**一键（推荐）：**

```bash
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash
```

脚本会 clone 到 `/opt/vm2api`、补全 `.env`（`chmod 600`）、`docker compose up -d --build`。`.env` 缺失或 `VM2API_ADMIN_PASSWORD` 为空时写入默认管理台 **`admin` / `123456`**（已有密码不覆盖）。空的 `VM2API_API_KEY` / `VM2API_DB_SECRET` 会生成随机值。登录：`http://<ip>:8787/cc#/login`。以后：

```bash
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade
sudo bash /opt/vm2api/deploy/install.sh check
sudo bash /opt/vm2api/deploy/install.sh changelog
```

保留 `.env` / `vms/` / `data/`。不要 `docker rm` 槽。一键更新会自动把新版 `share/wrap-cli`（包括 `kin-kernel.bin`）同步到所有槽并重启槽内 dataplane；如需暂时跳过可加 `--no-sync-wrap`。管理台 **设置 → 关于** 可复制同一条命令、看 changelog。指定版本：`--version v1.2.22`。

**手动：**

```bash
git clone https://github.com/dofastted/vm2api.git /opt/vm2api
cd /opt/vm2api
cp .env.example .env
chmod 600 .env
# 空密码默认 admin / 123456；API key / DB secret 为空时入口会生成

docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

二进制在仓内 `bin/`，Compose 会拷到挂载目录。`bin/kin-*` 必须 **755**。缺槽位系统镜像时会编 `kin-os/ubuntu:24.04`。

升级到 **v1.2.22** 见下面「已部署机升级到 1.2.22」。更新控制面和槽内 kernel，但不要 `docker rm` 槽。

Docker Desktop / WSL 下 `curl 127.0.0.1:8787` 可能失败：

```bash
docker exec vm2api python3 -c 'import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:8787/health").read().decode())'
```

槽位安装、同步和模板制作优先使用 `KIN_KERNEL_BIN` / `bin/kin-kernel`；母样本或槽内快照只在主内核不可用时使用。更新或上传主内核后，仍需同步并重启目标槽。控制面重启本身不会替换正在运行的槽内进程。

## 上线后

1. 打开 `/cc#/login`，用管理台密码登录（未配置时为 `admin` / `123456`）。
2. 代理池：添加本地出口，或导入 SOCKS5。
3. 建槽、绑出口、启动。没出口会停在 `stopped`。
4. 在槽里导入凭证，再用 `sk-vm-…` 或 master key 打 `POST /v1/messages`。

没出口或没凭证的槽不会进调度。

## 反代

Node 听 `:8787`。HTTPS 放在 nginx。

```nginx
location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header Authorization $http_authorization;
  proxy_set_header Connection "";
  proxy_buffering off;
  proxy_read_timeout 600s;
}
```

## 本机 Node（备选）

仓内已有 `bin/kin-*`。还要 `npm ci`、`pnpm -C web install --frozen-lockfile && npm run build:web`，以及占位 `vms/active.json`。单元：[deploy/vm2api.service](deploy/vm2api.service)。细节见 [BUILD.md](BUILD.md)。

## 一键安装 / 更新

`deploy/install.sh` 对齐 sub2api / CLIProxyAPI：查 GitHub 最新 Release → checkout tag → 重建控制面。不碰已有非空 `.env` 字段、`vms/`、`data/`，不 `docker rm` 槽。构建前若 `.dockerignore` 挡住 `CHANGELOG.md` 会自动补 `!CHANGELOG.md` 并重试一次。

### 两类安装错误

**1. `COPY VERSION CHANGELOG.md` / `"/CHANGELOG.md": not found`**

v1.2.7 的 `.dockerignore` 用 `*.md` 把 changelog 挡在构建上下文外。脚本会自动补一行；若仍失败：

```bash
cd /opt/vm2api
grep -q '!CHANGELOG.md' .dockerignore || echo '!CHANGELOG.md' >> .dockerignore
docker compose up -d --build
```

或 `curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade`。

**2. 管理台「Missing credentials」/「鉴权失效，请重新登录」**

打开登录页，不要直接进总览：`http://<ip>:8787/cc#/login`。未配置时账密是 `admin` / `123456`。已有密码：`grep '^VM2API_ADMIN_PASSWORD=' /opt/vm2api/.env`。

```bash
# 安装
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash

# 更新到最新 Release
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade

# 指定 tag
sudo bash /opt/vm2api/deploy/install.sh upgrade --version v1.2.22

# 只检查
sudo bash /opt/vm2api/deploy/install.sh check
```

面板：`GET /api/panel/version`、`GET /api/panel/changelog`、`POST /api/panel/update`（`{ confirm: true }` 才会在已挂 `docker.sock` 的机器上拉起升级助手）。容器里没有宿主机 git 仓时返回 `409 host_upgrade_required`，响应里带同一条 curl 命令。

## 已部署机升级到 1.2.22

1.2.22 修复 Anthropic 工具循环缓存边界：Node 保留上一轮稳定断点，槽内 kernel 只补当前尾部。升级必须同时更新 `bin/kin-kernel` 和 `share/wrap-cli/kin-kernel.bin`，再同步所有槽；不要 `docker rm` 槽。

推荐：

```bash
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade
```

脚本会重建控制面、调用 `wrap-cli/sync` 并重启槽内 dataplane。手动部署时必须完成同一同步步骤。

## 已部署机升级到 1.2.15

1.2.15 只动**控制面**（信封不再误拦蒸馏；同一 API key 信封粘一个账号）。不必换槽内 kernel，也不要 `docker rm` 槽。

推荐：

```bash
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade
```

手动：

```bash
cd /opt/vm2api
git fetch --tags
git checkout v1.2.15
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

本机 systemd：`git checkout v1.2.15` → `npm ci` → `pnpm -C web install --frozen-lockfile && npm run build:web` → `systemctl restart vm2api` **一次**。

## 已部署机升级到 1.2.14

1.2.14 只动**控制面**（第三方 cli-hop 改回 1.2.1 剥光；保留 1.2.12 convert 升块）。不必换槽内 kernel，也不要 `docker rm` 槽。

推荐：

```bash
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade
```

手动：

```bash
cd /opt/vm2api
git fetch --tags
git checkout v1.2.14
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

本机 systemd：`git checkout v1.2.14` → `npm ci` → `pnpm -C web install --frozen-lockfile && npm run build:web` → `systemctl restart vm2api` **一次**。

## 已部署机升级到 1.2.13

1.2.13 只动**控制面**（Compose 镜像名去掉多余逗号）。不必换槽内 kernel，也不要 `docker rm` 槽。

推荐：

```bash
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade
```

手动：

```bash
cd /opt/vm2api
git fetch --tags
git checkout v1.2.13
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

本机 systemd：`git checkout v1.2.13` → `npm ci` → `pnpm -C web install --frozen-lockfile && npm run build:web` → `systemctl restart vm2api` **一次**。

## 已部署机升级到 1.2.12

1.2.12 只动**控制面**（第三方 OpenAI 兼容口 cache 断点与 Anthropic Messages 对齐）。不必换槽内 kernel，也不要 `docker rm` 槽。

推荐：

```bash
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade
```

手动：

```bash
cd /opt/vm2api
git fetch --tags
git checkout v1.2.12
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

本机 systemd：`git checkout v1.2.12` → `npm ci` → `pnpm -C web install --frozen-lockfile && npm run build:web` → `systemctl restart vm2api` **一次**。

## 已部署机升级到 1.2.11

1.2.11 只动**控制面**（外层调度等待计划、额度受限三态、设置/列表）。不必换槽内 kernel，也不要 `docker rm` 槽。

推荐：

```bash
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade
```

手动：

```bash
cd /opt/vm2api
git fetch --tags
git checkout v1.2.11
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

本机 systemd：`git checkout v1.2.11` → `npm ci` → `pnpm -C web install --frozen-lockfile && npm run build:web` → `systemctl restart vm2api` **一次**。

## 已部署机升级到 1.2.10

1.2.10 只动**控制面**（Docker web `pnpm build` 类型检查；换仓内 `kin-cookie-auth`）。不必换槽内 kernel，也不要 `docker rm` 槽。

推荐：

```bash
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade
```

手动：

```bash
cd /opt/vm2api
git fetch --tags
git checkout v1.2.10
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

本机 systemd：`git checkout v1.2.10` → `npm ci` → `pnpm -C web install --frozen-lockfile && npm run build:web` → 换仓内 `bin/kin-cookie-auth` → `systemctl restart vm2api` **一次**。

## 已部署机升级到 1.2.9

1.2.9 只动**控制面**（thinking-only 残包同槽重试；一键安装补空账密；HTTP 裸 IP 登录不再丢会话）。不必换槽内 kernel，也不要 `docker rm` 槽。

推荐：

```bash
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade
```

手动：

```bash
cd /opt/vm2api
git fetch --tags
git checkout v1.2.9
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

本机 systemd：`git checkout v1.2.9` → `npm ci` → `pnpm -C web install --frozen-lockfile && npm run build:web` → `systemctl restart vm2api` **一次**。

## 已部署机升级到 1.2.8

1.2.8 只动**控制面**（`.dockerignore` 放行 `CHANGELOG.md`，修好 v1.2.7 的 compose `COPY CHANGELOG.md` 失败）。不必换槽内 kernel，也不要 `docker rm` 槽。

推荐：

```bash
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade
```

若还停在失败的 1.2.7 构建，可先手工：

```bash
cd /opt/vm2api
grep -q '!CHANGELOG.md' .dockerignore || echo '!CHANGELOG.md' >> .dockerignore
docker compose up -d --build
```

然后再升到 v1.2.8。

手动：

```bash
cd /opt/vm2api
git fetch --tags
git checkout v1.2.8
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

本机 systemd：`git checkout v1.2.8` → `npm ci` → `pnpm -C web install --frozen-lockfile && npm run build:web` → `systemctl restart vm2api` **一次**。

## 已部署机升级到 1.2.7

1.2.7 只动**控制面 Node + web**（版本检查、一键安装/更新、面板「关于」）。不必换槽内 kin-kernel / wrap CLI，也不要 `docker rm` 槽。

推荐：

```bash
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade
```

手动：

```bash
cd /opt/vm2api
git fetch --tags
git checkout v1.2.7
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

本机 systemd：`git checkout v1.2.7` → `npm ci` → `pnpm -C web install --frozen-lockfile && npm run build:web` → `systemctl restart vm2api` **一次**。

管理台 **设置 → 关于** 也可复制命令或（已挂 docker.sock 时）从面板发起。

## 已部署机升级到 1.2.6

1.2.6 只动**控制面 Node + web**（本地出口导入、kernel 探活、Setup Token 额度）。不必换槽内 kin-kernel / wrap CLI，也不要 `docker rm` 槽。

```bash
cd /opt/vm2api
git fetch --tags
git checkout v1.2.6
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

本机 systemd：`git checkout v1.2.6` → `npm ci` → `pnpm -C web install --frozen-lockfile && npm run build:web` → `systemctl restart vm2api` **一次**。

当前不在 1.2.5 的机器：若 wrap CLI 还是 `cli-dist`，先按下面「已部署机升级到 1.2.5」做 `wrap-cli/sync`，再 `git checkout v1.2.6` 重启控制面。

## 已部署机升级到 1.2.5

1.2.5 动两处：**控制面 Node** 和槽内 **wrap CLI ELF**（`cli-node` 替换原来的 `cli-dist`）。槽容器不要 `docker rm`。

### 1. 控制面

```bash
cd /opt/vm2api
git fetch --tags
git checkout v1.2.5
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

本机 systemd：`git checkout v1.2.5` → `npm ci` → `pnpm -C web install --frozen-lockfile && npm run build:web` → `systemctl restart vm2api` **一次**。

### 2. 槽内 wrap CLI

换 `vms/<id>/cli-home/.kin/cli-node`（以及 kernel.bin / 包装器）。用面板同步：

```bash
curl -sS -X POST http://127.0.0.1:8787/api/panel/wrap-cli/sync \
  -H "Authorization: Bearer $VM2API_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"restart":true}'
```

`ids` 可限定槽；省略则全槽。未启动的槽下次 start 会铺新文件。

## 已部署机升级到 1.2.4

1.2.4 只动**控制面 Node + web**（协议页简化 UI、缓存 TTL 默认 1h）。不必换槽内 kin-kernel，也不要 `docker rm` 槽。

```bash
cd /opt/vm2api
git fetch --tags
git checkout v1.2.4
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

本机 systemd：`git checkout v1.2.4` → `npm ci` → `pnpm -C web install --frozen-lockfile && npm run build:web` → `systemctl restart vm2api` **一次**。

## 已部署机升级到 1.2.3

1.2.3 只动**控制面 Node + web**（蒸馏拦截、创建槽 `start_error`、集群/列表页）。相对 1.2.2 **不必**换槽内 kin-kernel，也不要 `docker rm` 槽。

```bash
cd /opt/vm2api
git fetch --tags
git checkout v1.2.3
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

本机 systemd：`git checkout v1.2.3` → `npm ci` → `pnpm -C web install --frozen-lockfile && npm run build:web` → `systemctl restart vm2api` **一次**。同一轮不要 restart 两次，不要 `stop` 后不拉起。

当前不在 1.2.2 的机器：先按下面「已部署机升级到 1.2.2」换槽内 kernel，再 `git checkout v1.2.3` 重启控制面。

## 已部署机升级到 1.2.2

1.2.2 要动两处：**控制面 Node**（`prepareCliHopBody` 剥 messages 断点）和槽内 **kin-kernel ELF**。槽容器不要 `docker rm`。

### 1. 控制面

更新 Node，**重启一次**。

```bash
cd /opt/vm2api
git fetch --tags
git checkout v1.2.2
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

本机 systemd：`git checkout v1.2.2` → `npm ci`（web 有改再 `pnpm -C web build`）→ `systemctl restart vm2api` **一次**。同一轮不要 restart 两次，不要 `stop` 后不拉起。

### 2. 槽内 kin-kernel

换 `vms/<id>/cli-home/.kin/kin-kernel.bin` 和包装器 `kin-kernel`。用面板同步即可，**只同步 kernel，不是重装 wrap**：

```bash
curl -sS -X POST http://127.0.0.1:8787/api/panel/wrap-cli/sync \
  -H "Authorization: Bearer $VM2API_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"restart":true}'
```

`ids` 可限定槽；省略则全槽。等价拷贝：把仓内 `bin/kin-kernel` 装到该槽 `.kin/kin-kernel.bin`（755），并更新同目录包装器 `kin-kernel`。不要走 `POST /vms/:id/wrap-cli/repair` 当这次升级路径。

### 3. bounce kernel

每槽只留 **一个** kernel 进程，让它加载新 ELF。`sync` 带 `restart`（默认 true）一般会 bounce rust 槽。完成后确认槽内不是两个 `kin-kernel`。

未启动的槽下次 start 会铺新文件，不必先 sync。

---

交流见仓库 [README](../README.md)。
