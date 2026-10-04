# 实验性 Linux ARM64 控制平面部署

此方案在 ARM64 主机上原生运行 vm2api 控制平面，并通过 QEMU 运行现有
`linux/amd64` slot。它适合独立部署，应用版本来自当前源码 checkout，
不依赖某个上游 vm2api 发布镜像或版本号。

## 支持范围与已验证情况

控制镜像中的 Node.js 22、Python、iptables、Docker 27 CLI，以及静态 Go
worker 和 egress 二进制均为 ARM64。已有 Rust kernels、OAuth 和 CLI 预编译
资产仍为 amd64，由 QEMU 执行；slot 默认平台也是 `linux/amd64`。
构建从固定的 Ubuntu 24.04 amd64 stage 提取 glibc 2.39 等 x86 库，Go builder
和最终控制平面 stage 使用 ARM64。

| 场景 | 验证状态 |
| --- | --- |
| Oracle Ampere、Ubuntu 24.04 主机上的 ARM64 控制平面 | 已在现有部署验证 |
| 该部署中的 Ubuntu amd64 Claude slot | 已在现有部署验证 |
| 原生 ARM64 远程节点 | 未验证 |
| Codex 模型真实请求、其他 guest 镜像 | 未验证 |
| 主机重启后的恢复、性能与容量 | 未验证 |

这些结果只覆盖上述环境，不构成其他 ARM 主机、镜像或负载的兼容性承诺。
**每个 Docker daemon 仅运行一个部署**：slot 使用 `kin-01` 等全局容器名称，
即使为控制容器指定不同名称，也无法隔离 slot。已有 x86 部署的主机不要直接
叠加此 override；迁移应先停止原控制器并保留其状态和密钥。

## 主机要求

- Linux `aarch64` 主机，启用 `systemd-binfmt`。
- 已安装 Git、Python 3、可用的 Docker Engine 和 Compose V2。
- 当前用户可访问 Docker daemon；准备脚本需要 root 或可用的 `sudo -n`。
- 可访问构建镜像来源，并具备运行 amd64 slot 所需的内存、磁盘和 CPU。

Docker 的安装方式参见 [Docker Engine 安装文档](https://docs.docker.com/engine/install/)。
此 override 不强制设置 CPU 或内存上限；容量应按实际 slot 数量和负载规划。

## 准备主机

以下命令均在仓库根目录执行。安装 QEMU handler 后检查状态：

```sh
python3 deploy/prepare-arm64.py
python3 deploy/prepare-arm64.py --check
```

`--check` 只读取状态。安装使用固定的 `tonistiigi/binfmt` QEMU 10.2.3 资产，
只切换 `qemu-x86_64` handler。脚本检查受管理路径，遇到符号链接或不同内容
时拒绝覆盖。安装失败时恢复原内核 handler 描述及启用状态，
并只移除本次新安装的文件。发行版的 binfmt 数据库和其他架构 handler 不参与此事务。

## 初始化与启动

为新部署创建 `.env`：

```sh
python3 deploy/init-arm64-env.py
```

默认端口为 `8787`，控制容器名为 `vm2api`，仅绑定 `127.0.0.1`。可用
`--port`、`--container-name`、`--bind-host` 调整这些值。若要绑定其他地址，
应先确认该地址的访问范围和主机网络配置；IPv6 绑定需要宿主机启用 IPv6。

初始化器以排他创建方式写入权限为 `0600` 的 `.env`，生成管理密码、API key
和数据库密钥，且不输出凭据。已有 `.env` 会保留并提示本地审查。用本地编辑器
查看 `VM2API_ADMIN_PASSWORD` 后登录；不要把 `.env`、凭据或会话信息放入 PR。

```sh
docker compose -f docker-compose.yml -f docker-compose.arm64.yml build vm2api
docker compose -f docker-compose.yml -f docker-compose.arm64.yml up -d vm2api
```

override 的默认本地镜像是 `vm2api-arm64-control:local`，可通过
`VM2API_ARM64_IMAGE` 改名。Compose 使用 `deploy/Dockerfile.arm64-control`
构建 `linux/arm64` 控制镜像；`DOCKER_DEFAULT_PLATFORM=linux/amd64` 用于
控制平面启动的 slot。amd64 集群资产置于 `/opt/vm2api/cluster-bin-amd64`。

持久目录位于仓库下的 `.local/arm64/`：

| 目录 | 用途 |
| --- | --- |
| `vms` | slot 相关持久状态 |
| `data` | 控制平面数据 |
| `bin` | 运行时二进制目录 |
| `share` | 共享文件 |
| `config` | 运行配置 |

仓库原有 `bin/` 中的 amd64 资产会保留。备份时同时保留 `.env` 和这些持久
目录，数据库密钥必须与原数据库对应。

## 检查状态

```sh
docker compose -f docker-compose.yml -f docker-compose.arm64.yml ps
docker compose -f docker-compose.yml -f docker-compose.arm64.yml logs --tail=100 vm2api
docker compose -f docker-compose.yml -f docker-compose.arm64.yml exec vm2api node -p process.arch
python3 deploy/prepare-arm64.py --check
```

Node.js 应返回 `arm64`。随后在本地浏览器打开 `http://127.0.0.1:8787`，
登录并检查账户、slot 和实际请求。使用自定义端口时替换地址中的端口。
容器启动或架构检查成功，不能代替真实模型请求验证。

## 更新源码与镜像

先保存当前源码 revision，并备份 `.env` 和持久数据。更新应在干净的源码
checkout 中进行；有本地修改时先审查并保留这些修改。

```sh
git pull --ff-only
docker compose -f docker-compose.yml -f docker-compose.arm64.yml build vm2api
docker compose -f docker-compose.yml -f docker-compose.arm64.yml up -d --no-deps vm2api
```

更新保留原有挂载目录与密钥。完成后重复状态检查及之前成功的实际请求。
基础依赖的固定 digest 应单独审查和维护，不随应用 `VERSION` 自动刷新。

## 故障恢复与迁移

QEMU 准备失败时先阅读脚本错误，再运行 `--check` 核对恢复后的状态；不要
手动覆盖发行版的 binfmt 文件。应用故障可恢复已保存的源码 revision，重新
构建并用相同 Compose 参数启动；数据库发生格式变更时，按对应版本的迁移
要求恢复匹配的数据备份，避免旧代码直接读取不兼容数据库。

已有部署改用此方案时，先核对旧控制器的数据库、密钥、配置和各目录挂载，
备份后停止旧控制器，再制定与新挂载对应的迁移步骤。不要任意移动仍在使用
的数据库，也不要同时启动两个会管理相同 slot 的控制器。成功验证登录、
账户、slot 与实际请求后，再决定是否保留旧部署作为恢复入口。
