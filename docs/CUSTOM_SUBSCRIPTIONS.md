# 共享订阅定制版维护

## 版本与功能

定制分支为 `codex/subscriptions`。`subscriptions-v1-20261002` 保存首次部署基线；`subscriptions-v2-20261002` 保存分配向导、个人工作台和迁移隔离版本。标签与分支先保存于本地；向服务器保存 Git bundle 后可离线恢复，不能将其当作已经推送至 GitHub。

管理员可从订阅页「开始分配订阅」、槽位行或用户行进入向导，依次选择方案、槽位、用户和确认分配。新建方案与分配用户在一个数据库事务中完成。额度属于每位用户，重复分配会续期而不清零用量。

普通用户只能看到自己的订阅、密钥和使用记录。「我的订阅」显示剩余额度、待结算预留、重置时间、有效期、配置状态、创建密钥和客户端接入指引。槽位未登录时明确提示管理员处理；「已配置调用条件」不表示已经验证上游服务可用。

`subscriptions-v3-20261002` 增加按 Key 展示用量、带筛选的明细跳转、密钥用量对比、URL 筛选保留、局域网 HTTP 复制兼容和手机卡片布局；订阅首页缩小引导并折叠接入教程。Key 自身限额和订阅额度独立展示，重置 Key 的计数不会恢复订阅额度或删除历史用量。本版本没有新增数据库迁移。

## 合并上游

1. 保存当前修改，并给线上版本保留标签及数据库备份。
2. `git fetch upstream` 后从定制分支创建临时合并分支，例如 `git switch -c codex/merge-upstream codex/subscriptions`，再 `git merge upstream/main`。如果上游使用其他主分支，按其实际名称调整。
3. 检查冲突，重点复核鉴权、请求路由、记账、数据库和前端导航。定制边界主要在 `panel-subscriptions.mjs`、`subscriptions-repo.mjs`、`custom-migrations`、`web/src/features/subscriptions`，但请求鉴权和计费也修改了核心调用链，不能只保留这几个目录就假定合并正确。
4. 运行相关后端测试与前端测试，执行 TypeScript 检查和 Vite 构建。确认普通用户不能跨用户读数据，撤销订阅立即阻止密钥调用，失败的向导提交不留下半成品。
5. 对齐 Docker 基础镜像与合并后的上游版本，包括 Node 依赖、worker、egress 二进制。当前 Dockerfile 是在上游镜像上覆盖源代码与前端；它不会自动安装新版依赖或编译 Go，因此升级上游不能永远沿用旧基础镜像。
6. 在数据库副本验证后部署，完成验收再把通过的合并结果快进到 `codex/subscriptions` 并建立新版本标签。

不直接用上游镜像覆盖定制容器。定制镜像设置 `VM2API_CUSTOM_BUILD`，面板的官方升级接口会拒绝覆盖并说明原因。

## 数据库迁移

上游继续使用 `src/lib/db/migrations` 和 `schema_migrations`；定制功能使用 `src/lib/db/custom-migrations` 和 `custom_schema_migrations`，版本号独立。后续定制 SQL 新增编号文件，不修改已经应用的文件。

v1 的 `027_subscriptions.sql` 在 v2 改为定制 `001_subscriptions.sql`。升级时先验证旧迁移文件名与内容校验和，再把记录移到定制表，不重复执行 SQL、不删除业务数据。后续上游的 027 可以正常使用。命名空间隔离不会自动解决同名表、列或行为上的冲突，仍须审查上游变更。

## 当前部署与回滚

服务器目录 `/home/yibocho/vm2api`，服务端口 8787。发布包放入 `releases/subscriptions-*` 新目录，写入当前提交哈希到 `CUSTOM_REVISION`，再从该目录运行 `sh deploy/subscriptions-release.sh`。发布包必须包含 `src`、`scripts`、`VERSION`、`web/dist` 和部署文件；不打包 `.env`、账号凭据或运行数据。

脚本保存数据库一致性快照、配置、Compose 文件与旧镜像标识到 `backups/<UTC时间>`，构建定制镜像，用数据库副本执行迁移，检查完整性及核心表行数，然后只重建 vm2api 服务。发布后检查健康接口、前端资源、角色权限、订阅分配和撤销。当前槽位没有上游凭据时，不能把本地或模拟测试当作真实模型调用验收。

从 v2 回退 v1 时必须恢复配套的数据库快照：v1 不认识独立的定制迁移记录，单纯切换旧镜像不安全。先停止 vm2api、另存当前数据库及其 WAL/SHM，再恢复该备份目录的 `kin.db`、配置和 Compose 覆盖文件并启动；切换数据库会丢失备份之后的业务写入，应在实际回滚前核对时间和影响。不要删除账号槽位容器或其他服务。
