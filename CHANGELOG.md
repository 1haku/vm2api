# Changelog

## 1.3.170 — 2026-10-15

- 本地代理拆成每台 VPS 一条：控制面 `px-local`，每个集群节点 `px-local-<节点 id>`，接入节点时自动建立。绑定额度、测通、测地理都按各自机器算，不再「所有节点共用」，节点行的探测看该节点的 SSH 链路，地理经节点本机出网查询。槽位只能绑它所在机器的本地代理，传通用的 `px-local` 会自动落到槽位自己机器的那一行，绑到别的机器返回 `local_proxy_node_mismatch`。升级后首次启动会把挂在 `px-local` 上的节点槽迁到各自节点的行，docker 网络不变，运行中的槽不用重建。（#329，#428）
- 虚拟机列表的出口芯片点击即测这个槽的真实出口 IP 与地理（`POST /api/panel/vms/:id/exit-probe`，仅 admin）。本地代理槽测它所在 VPS 那条本地代理，结果同步到代理池页；未绑定或被策略封禁的槽不可点。（#428）
- 新增管理员接口 `POST /api/panel/vms/:id/credential/clear`：清空槽位凭证与账号字段并关闭调度（`no_credential`），保留槽位本身及其代理、时区、指纹等配置。（#438）
- 修复 GPT 槽邮箱显示：导入按「显式邮箱 → ID Token → Access Token」补全身份，账号 ID 不再被当成邮箱，重新导入不再继承旧账号凭证，有凭证但邮箱未知的槽显示「已导入账号 · 邮箱未知」而不是空槽。（#432）
- 修复 Claude 省略 thinking 时首字时间（TTFT）记得过晚、导致输出速度虚高：带 `estimated_tokens` 的 thinking 增量即计为首次输出。（#431）

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。无数据库迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。接了集群节点且用本地代理的部署，首次启动会把节点槽迁到各节点自己的本地代理行，并改写 `vms/<id>.json` 里的 `proxy.id`（日志 `[local-egress] vm: px-local -> px-local-<节点>`）；要回滚到旧版本，先备份 `vms/` 和 `data/`。

## 1.3.169 — 2026-10-14

- 修正 #411 改坏的 0 注入契约测试。空的常驻约束仍保留零宽 agent 槽；用量遮罩继续盖住计费头、该槽和 Environment，不盖调用方剩余 system。没有运行时行为变化。

已部署机升级：更新 Node 控制面，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.168 — 2026-10-14

- 计费改为三层价格：手动覆盖 > models.dev > 内置官方快照。models.dev 每 24 小时同步，缺的模型和档位（Mythos、gpt-6、Claude fast、OpenAI flex / priority、长上下文、1h 写入）由内置快照补。修正 Sonnet 5.5 缓存读 $0.10、Fable 5.1 / Mythos 5.1 缓存读 $0.25；去掉 Sonnet 4 / 4.5 超 200k 的加价。Anthropic web search 按 $10 / 1000 次计入费用。缓存写没有 5m / 1h 拆分且未声明 1h 时按 5m 计。
- token 口径统一：`usage_logs.input_tokens` 一律不含缓存，OpenAI / Codex 在写入时扣掉缓存读写。「总 Token」= 输入 + 输出 + 缓存读 + 缓存写，每类只算一次；GPT 不再重复算缓存。虚拟机窗口、`total_tokens`、`today_tokens` 现在都含缓存。`/billing` 的 `tokens_in` 改为输入 + 缓存。
- 托管 key 扣额度与写入日志用同一份计价结果，每个请求只计价一次。
- 模型页拆成「模型」「计费」两个 Tab。计费 Tab 显示每个模型的有效价、来源和与内置价的差异，可编辑覆盖、手动同步 models.dev、按时间段「按当前价重算」（只改官方价 `total_cost`，不动 `actual_cost` 和 key 已扣额度），并列出未定价模型。
- 模型目录自动同步：启动 5 秒后和每 6 小时经 OAuth 槽拉 Claude `/v1/models` 和 ChatGPT Codex 目录。新模型只在 `worker_only` 下直接对外，其他情况先加入并关闭。
- 虚拟机列表拆清三列职责：「今日 / 7D 请求」只显示次数；「用量窗口」只显示额度占比和重置时间；「成本」统一显示 5H / 7D / 总计的官方费用与含缓存 token。网格、展开详情及「查看统计」共用同一份窗口与成本组件，移除列表和弹窗里的估算总量／剩余金额、顶部全池剩余估算及重复累计指标；完整详情页与 API 的估算能力保留。
- 网格卡片底栏将逐格 session slot 改为按设置上限显示的席位容量条（已用 / 上限，保留宽限和排队提示），修复 20 席位挤出调度开关与菜单的问题；限额操作移到用量区，中／大卡片按实际宽度叠放或并排，金额与 token 完整对齐。
- 新接口 `GET /api/panel/pricing`、`PUT /api/panel/pricing/overrides`、`POST /api/panel/pricing/sync`、`POST /api/panel/pricing/reprice`；`/vms`、`/vms/:id`、`/usage` 新增 `estimate_5h` / `estimate_7d` / `estimate_fable` / `window_fable_cost`。见 `docs/PANEL_API.md`。
- API 后端空 system 也会套已配置的官方提示词。`rewrite` 的计费头放在 cache 断点之后。
- 拒答守卫改为不可重试的 400 `policy_blocked`（`code` 仍是 `refusal_guard`），不再返回 503，避免 Claude Code 误提示登录。
- 远程节点的 egress 容器改用配置文件属主的 uid:gid 运行；崩溃循环或旧规格会重建。
- `POST /api/panel/vms/pool-policy` 批量改权重、调度等级和并发上限。单槽 `PATCH` 也可以改 Codex `weight`。
- 修复 GPT OAuth 授权成功后虚拟机面板仍显示「未绑定账号」：换票后从 `id_token` / `access_token` 解析邮箱与 ChatGPT 账号 id。（#409）
- 默认环境变量管理员写入用户列表，可在面板改密码。引导是否完成看数据库密码，不再只看 `.env`。

已部署机升级：**升级前先备份数据库**。迁移 037 会就地把历史 OpenAI / Codex 行的 `input_tokens` 改成不含缓存（判据与原缓存命中率完全一致，命中率分母不变），无法自动撤销，回滚只能恢复备份。已经跑过 037 的机器不会再改这些行。更新 Node 控制面与 `web/dist`，重启一次 Node。无新依赖，不必 `wrap-cli/sync`。控制面需能访问 `https://models.dev`，访问不了时按内置快照计价。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.167 — 2026-10-14

- 官方档在调用方没有 system 时也出站四段：计费头、身份句、官方 prompt、Environment。顺序跟 cli-node 一致，计费头在 prompt 前面。调用方自己的 system 仍放在第 5 段。

已部署机升级：更新 Node 控制面，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.166 — 2026-10-14

- 计费头改放到最后一个 `cache_control` 之后。`cch` 仍按整份 body 变化，但不再打进 1h 前缀，`cache_read` 可以越过工具尾断点。

已部署机升级：更新 Node 控制面，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.165 — 2026-10-14

- 虚拟机页的网格视图改成机架地图：按服务器分机架，机架内按状态分区（在池 / 受限 / 关闭调用 / 未使用 / 无效凭证）分段。机架头显示本机状态构成、席位占用和 5h / 7d 费用与 token 合计，只统计当前筛选下可见的槽位。
- 每台槽位按「费用 / token」两行显示 5h、7d、Fable（仅 Max）和累计四列，竖柱带 70% 刻线和重置倒计时，并显示近 7d 占累计的比例。无效凭证、空槽、额度未探测的槽位直接给出重新授权、绑定凭证或刷新探测。
- 卡片分小 / 中 / 大三档，默认打开网格·大；视图和尺寸会记住。顶部状态分区条同时用于网格和列表的筛选，吊销并入无效凭证。排序新增 7d 费用和累计费用。
- `GET /api/panel/vms` 与用量账号行新增 `total_tokens`（累计输入 + 输出，不含缓存），和 `total_cost` 同源。

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.164 — 2026-10-14

- 官方提示词把调用方的官方长提示词放回 agent 槽，并在该块打 1h 断点。不再只留身份句。
- 计费头的 `cc_prompt_index` / `cc_turn_index` 固定在首轮，避免每轮改写 system 前缀、把缓存打穿到工具断点。
- `role=system` 留在消息列表。第 5 段只放顶层 system，对话前缀可以随轮次增长。

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。已保存的官方档模板即使没有 `{{caller_agent}}`，出站仍会把官方长提示词插回 agent 槽。

## 1.3.163 — 2026-10-14

- 官方请求也套用协议里设置的 system 档，包括 custom。分类器请求仍不改。
- 协议页「入站准入」新增「官方 Claude Code 家族透传」，默认关。打开后，直连和被识别为中转的官方家族保留入站 system（billing、身份句、system 上的 cache_control），不套当前提示词档。

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。开关默认关，升级后官方家族会套用当前 system 档；要恢复透传，在协议页打开该开关。

## 1.3.162 — 2026-10-14

- 风险审计的蒸馏关不再写死收割包装、赛题正则和思考预算下限。这些值只来自面板保存的 `distill-rules.json`：`hard_needles` 是收割包装（官方客户端和 0 注入也拦），删掉即停，不会补回；结构收割的 `max_tokens` 和思考预算都用 `structure.min_max_tokens`；`contest_pattern` 留空则不做赛题结构判断。返回文案也只用该文件里的 `error.message`。出厂 `patterns` 为空，知识蒸馏 / 提取思维链仍由硬正则的 distill 类别拦截，避免两份名单。

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。旧的 `distill-rules.json` 若没有 `hard_needles`，加载时把仍写在 `needles` 里的出厂收割句归到收割包装；已经从 `needles` 删掉的不会补回。整份替换该文件则会用仓库里的新出厂配置。

## 1.3.161 — 2026-10-14

加强和优化时区。加强针对 omp、pi 的单独优化。

## 1.3.160 — 2026-10-13

- 系统提示词按五段注入。官方完整是标准：billing、identity、agent、env，调用方 system 在可选第 5 段。官方提示词和 0 注入用同一槽位；第 3 段只放常驻约束，空则去掉。顶层 system 和消息里的 `role=system` 都进第 5 段，不再抬成中途 `role=system`。
- cli-hop 先剥掉入站 billing、identity 和 `# Environment`，再按槽位档覆写。cli-node 只有在出站已经带 billing 和 identity 时才原样放行，否则仍由 CLI 补回计费头和身份句。
- OMP / oh-my-pi 仍是非官方流量：正文进第 5 段，自带的 billing 和 `local-agent` 前缀不转发。旧的 `rewrite` 模式仍把中途 `role=system` 留在消息列表里。

已部署机升级：更新 Node 控制面，并把 `share/wrap-cli/cli-node` 同步进 Anthropic 槽（`wrap-cli/sync`，`restart: true`）。Codex 槽不用这枚 CLI。重启一次 Node。无迁移、无新依赖。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.159 — 2026-10-13

- 风险审计的账号范围改为按「平台 · 套餐」筛选（Claude Max/Pro 跟虚拟机列表同一套判断，GPT 按套餐）。不再按凭证形式。范围条在页面顶部，可收起。只选 GPT 套餐时 Claude 照旧全进关卡；选了 Claude 套餐或指定账号后，没命中的 Claude 才放行。GPT 在设了范围后只检查命中的套餐。没设范围时行为与 1.3.158 相同。

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。没设账号范围的关卡，行为与 1.3.158 一致。

## 1.3.158 — 2026-10-13

- 伪造健康探测头（`x-health-real` 一类）不能再绕过密钥配额。内部已认证的健康探测仍不计配额。
- 风险关卡可按已有槽位字段收窄：凭证形式、`plan_type`、槽位 id / 邮箱 / 名称。三个名单取并集，全空时所有账号照旧进关卡。不新增账号属性。Claude 不受这个范围影响。
- 新增单槽「工作时段」（`policy.active_hours`：开工 / 收工、可选星期与钉住时区，开工晚于收工为跨夜班次）。窗口外该槽不参与调度：Claude 在模型与额度门禁之后判，Codex 直接跳过；整池都在休息时两侧都 503 `pool_unavailable` 并带 `Retry-After`（最近开窗时间）；Codex 续接 `previous_response_id` 时绑定槽在休息返回 409 `response_not_portable`。健康探测不挑休息中的槽，pin 诊断不受影响。时区取窗口自带值 → 槽位时区 → UTC，夏令时切换日按实际时刻判定。面板「调度」编辑器可设置，列表显示「休息时段」（受限），新增 `active_hours_timezone` / `active_hours_active` 字段；导出包、写回与重建保留窗口，无窗口导出为 `null`。

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。没设工作时段的槽、没设账号范围的关卡，行为与升级前一致。

## 1.3.157 — 2026-10-13

- 增加 Fable 多轮 system 前缀的回归测试，防止历史 system 提醒被抬进顶层 system、冲掉缓存前缀。不改运行时行为。

已部署机不必为这一版升级。没有协议、配额或出口变化，无迁移，不必 `wrap-cli/sync`。

## 1.3.156 — 2026-10-13

- kin-egress 的 DNS-over-TCP 在同一连接上连续回答查询。解析失败回 SERVFAIL 后继续读下一笔，不再在首个应答后关闭连接。解析期间不占用客户端的 10 秒读写超时。
- 面板会话 `panel-sessions.json` 改为同目录临时文件原子替换，权限 `0600`。已经过宽的文件在加载时收紧。写入或加载失败会记一条日志，不再静默丢掉。
- 决策模型不可用且关闭失败放行时，只拦截当前请求，不再把客户端 device 永久封禁。503 拒答缓存在原句后说明是设备封禁、精确一致还是相似正文。

已部署机升级：更新 Node 控制面镜像（内含本次 `kin-egress`）并重启一次 Node。已经在跑的出口要换成这次发布的 `kin-egress`，DNS TCP 复用才会生效。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.155 — 2026-10-13

- 虚拟机详情 → 代理 tab 的出口下拉改为可输入筛选：输入名称、地址、国家、城市、时区或 ISP，只列匹配的可用节点，选中后点「绑定」。
- 「代理」页的搜索框改为筛选可用节点：有关键词时只显示可绑（未禁用、非 dead、无 IPv6 拦截）且有空位的代理，已满或失效的不参与匹配；清空关键词恢复全部列表。
- 「代理」页重排，找节点更快：席位图改成整页宽的横条放在顶部，健康图例仍可点击筛选；下方新增地区栏（本地出口、各国家，城市多于一个时可再细分），每档显示当前筛选下的条数和可绑空位，点一下就筛到该地区。地区栏在超宽屏（≥1536px）是表格左侧的竖栏，更窄时是表格上方的一排，笔记本宽度下表格不被挤成卡片。列表在宽屏下对齐成表格（节点、地区、状态、延迟、席位、已绑槽位、操作），点表头排序、再点翻转。「添加代理」「池设置」收进页头按钮打开的右侧抽屉，「全部测通 / 全部测地理」移到页头。窄屏时表格退回卡片排布。
- 代理列表每条压成一行（约 40px，1366 宽一屏约 13 条）：名称后跟地址，地区只显示国家 · 城市，席位改成「n/上限」+ 小格，已绑槽位行内最多显示 2 台、其余折成「+N」，行尾只留测通和「更多」菜单。点名称展开详情：完整地址、出口地理与 ISP、最近错误、全部已绑槽位与绑定、测地理 / 复制 / 编辑 / 启停 / 删除。顶部席位图变矮，待接代理收成一行。
- 顶部席位图改为按地区成簇的点阵：一个点一个绑定位，实心为已绑（按代理健康着色），空心为可绑空位，淡点为失效 / 禁用代理上用不了的位；一条代理一列，上限高的（如本地代理）折成相邻几列而不是拉高整图。每簇标出地区名和空位数，点地区名即筛到该地区，悬停 / 点列仍与表格行联动。地区栏可收起：竖栏收成只显示地区代码和空位数的窄条（60px），横排收成只剩当前选中的一档；收起状态记在浏览器里，不清除筛选。

已部署机升级：更新 `web/dist` 与 `VERSION`，重启一次 Node 让面板显示新版本号。Node 控制面代码、二进制、kernel / CLI payload 与 1.3.154 相同，无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.154 — 2026-10-13

- 欢迎页首配增加用法选择。个人自用关闭 5h/7d 闸，三档闸线拉到 100%，执行并发拉到 256，RPM 保持不限；蒸馏、硬正则、拒答缓存关掉，决策模型维持关闭且阈值降到 0。中转站把这些项写回出厂值：闸开着，default/Pro 并发 2、Max 并发 4，闸线 85%/80%（Max 95%），蒸馏、硬正则和拒答缓存开着。两种模式都不改提示词、探测、健康缓存和其余开关。`PUT /api/panel/onboarding` 增加 `{ action: "profile", mode: "personal" | "relay" }`，选择记在该用户的引导状态里，完成或跳过引导后仍保留。
- 欢迎页补了各主要页面的一句话说明。配额、风险审计、密钥、虚拟机用量、内核重装多一句：配额闸在设置「配额」；风险审计是出站前的四道关；密钥用 `sk-vm-`，不要把主控密钥写进环境变量；5h/7d 用量在虚拟机列表；内核重装不改凭证、代理和容器。
- system 提示词在没有 `persona_preset`、也没有 `persona_inject` 时默认完整官方提示词[+182653 bytes at .content[1].resource.text]