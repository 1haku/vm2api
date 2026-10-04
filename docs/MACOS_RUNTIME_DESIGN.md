# macOS Runtime 施工方案

## 1. 状态与范围

这是主进程与 Claude CLI 对 macOS 专项方案的设计，不是运行证明或支持声明。Linux 阶段已提交为 `9e70947`，见 [Draft PR #232](https://github.com/dofastted/vm2api/pull/232)。macOS 仍关闭；不发布、合并或部署。

当前只有 WSL2/Docker Desktop/Linux x86_64 验证环境，daemon 没有 `/dev/kvm`，没有已核准 Apple 宿主、guest、用途许可记录或完整 Darwin 产品。只有 Go Darwin/amd64 Mach-O 交叉构建，未执行，不能作为 A08 通过。

保持原 `macos-15`、Darwin/x86_64、`runtime=kvm` 的验收范围。先验证 `docker-qemu` 单一生命周期管理者；`libvirt` 是需要独立 profile 和签收的替代，不同时接管一个实例。Apple Silicon/Virtualization.framework 是独立 provider、架构条目和验收路线，不自动替代 x86，也不退回 Ubuntu。两条路线目前均 blocked。

## 2. 宿主准入与兼容性锁

启动前必须同时具备管理员核准的 `license_review_ref`、宿主记录、完整兼容性锁。客户端布尔值、宿主品牌标签、容器能启动都不是许可证明。

[Sequoia SLA](https://www.apple.com/legal/sla/docs/macOSSequoia.pdf) 涉及宿主硬件、运行 Apple Software、用途、实例数量及 relay service 限制/例外。Apple 硬件运行 Linux/KVM 也必须审查具体条款或适用书面协议；不能仅凭 Apple 硬件放行。VZ 路线同样需要用途/数量审查，不预设固定实例上限。

兼容性锁采用不可变的规范化数据和 hash，变更生成新锁。必须包含：

- macOS 具体版本/build、合法安装来源和下载产物摘要。
- provider 构建；x86 的 launcher digest、QEMU machine/CPU、OpenCore/EFI/config 摘要和兼容 SMBIOS 元组；ARM 的真实硬件模型与受支持宿主要求另设锁。
- CPU 指令约束、guest RAM、磁盘与控制通道配置；GPU/display 的真实设备模式与加速能力。
- 每个 kernel、CLI、OAuth、worker/管理组件的 Darwin target、依赖、摘要、协议版本、签名和实机结果。
- 宿主批准记录、观测方法、各字段控制能力和已测资源开销。

不提供 raw QEMU `ARGUMENTS`、任意环境透传或未审核参数逃生口。CPU/板卡/GPU 不混搭虚假信息；不使用他人真机序列号，不默认登录 Apple Account。只公开允许分发的 launcher/工具，不公开安装盘、恢复缓存、账号或密钥。

preflight 必须在真正运行 VM 的节点执行。x86 检查 KVM/指令/权限；VZ 检查其实际宿主能力而非 `/dev/kvm`。8192 MiB 是当前 catalog 门槛，不是已测容量。预算必须包含 guest、实测 QEMU/管理/图形开销、宿主保留和最坏磁盘占用，事务化预留且不超售。

## 3. provider 命令与物理资源守卫

沿用现有 Node 控制面、registry、调度与数据库，不重写凭据模型。拟议 macOS provider 实现 capabilities/preflight/prepare/create/inspect/stop/destroy/collectIdentity；没有真实宿主前不提交空实现或假成功适配器。

命令内部必须绑定以下字段：

| 字段                                         | 作用                                     | 可见性                       |
| -------------------------------------------- | ---------------------------------------- | ---------------------------- |
| owner_scope、node_id、vm_id                  | 经认证的宿主与存储归属                   | scope/内部节点细节不公开     |
| operation_id、generation、spec_hash、lock_id | 当前操作及规范化规格                     | 只按现有 public 白名单投影   |
| restore_epoch                                | 已授权恢复代次                           | 不是物理隔离证明             |
| resource_id、physical_handle                 | 精确 CID/domain UUID/磁盘/NVRAM/端口归属 | 内部；不公开私有路径         |
| request_id、payload_hash                     | 同请求返回同结果，换内容冲突             | 内部                         |
| nonce、deadline                              | 挑战/防重放和有界执行                    | 内部，不进入 public snapshot |
| payload、result、observed_at                 | 类型化动作、认证回执及观测               | 结果经白名单脱敏             |

宿主持久化当前授权 tuple，并将每个 VM 的实际资源动作串行化。执行前须匹配控制面授权的完整 tuple，而不是接受任意 `generation >= current`。重复 request 先核规格和授权代次，正常幂等重试不被 nonce 消耗误伤；旧回执不能当作当前 running/readiness 证明。

现有 `guestProvisioningToken()`、`guestOperationCurrent()` 等守卫仅对 `linux-account-v2` 生效；其他 contract 返回 null/true。未来必须明确加入 macOS 的严格分派与数据库锁路径，不能直接复用入口就宣称有 fence。legacy 保持既有行为，未知新 contract 明确拒绝。

restart/reload 保持本实例账号、磁盘/NVRAM、身份和仍归属该实例的稳定 handle；不因 generation 变化盲目换端口/CID。发生 recreate 时只操作已经核准的固定物理 ID。取消、超时、失联后若无法证明 create 不会迟到，资源置 quarantine、继续占预算；确认停止、残余资源不存在/已回收且不能迟到重建后，才释放对应预留。停止保留的磁盘不是可重新分配的空闲存储。

## 4. 实际账号与状态

拟议 `macos-account-v1` 与 Linux 账号池分离。短用户名是期望值，UID/GID、HOME、组与 euid 从每个真实 guest 读回，不套 Linux 全局 20000+ UID 池、不套 `/home`、不假定 UID 必然 501 或 UID=GID。

首次 PoC 通过受信、单次授权控制台完成 Setup Assistant。核对用户名、NSS、`/Users` 实际 HOME、业务进程 euid/目录 owner、组、重启登录及 host key。密码不进入 argv、Compose env、日志、公共 API、镜像 layer，也不记录密码输入画面/键盘事件。SSH 私钥由 guest 生成；公钥先经受信控制台/认证 bootstrap 核准再 pin，禁止默认 TOFU、自动重新 pin；host-key/auth 错误 fatal，不重试。

人工 Setup Assistant 只签收 PoC，不降低最终“自动建立 OS 与用户”要求。最终自动初始化器必须在合法自有模板/安装流程中使用受支持账户机制、一次性秘密与授权公钥，实测幂等、清除 bootstrap、首次管理员和权限。写 plist、`.AppleSetupDone` 或自动登录参数不能代替建用户。Secure Token/FileVault/MDM 未验证则标明未支持对应能力，不能假装成功。

只扩展现有 provisioning 状态契约并更新所有消费者，不另建 provider 状态机。`runtime.status` 仍表示实际 running/stopped；planned/admitted/booting/needs_setup/os_ready/cli_ready/slot_ready/cancelled/failed 等阶段按现有真实名称统一映射。Linux 已存在 `os_ready`，不能改变其语义。账号或完整产品未就绪、无可用凭据、代理强制点未验证时均不可调度。

API/UI 显示阶段、锁引用、阻塞原因、脱敏账号和能力；needs_setup 明确需要操作员。未批准/未支持不落物理资源、不启动 guest；错误保留定位 code，不吞错、不给 Ubuntu fallback。未知/冲突输入沿用 400，前置条件或 stale/fence 冲突按现有 409 风格，host-key/auth 失败不自动重试，临时 host 不可达只做有界查询/重连，不重复盲目 create。具体新增 code 属于后续实现契约，不伪称当前已经支持。

## 5. Darwin 产品、传输与出口

数据面设计：

```text
client -> Node 协议清洗 -> 经认证的现有 RPC/字节传输
       -> guest Darwin native kernel / CLI -> 已选代理链 -> upstream
控制面：Node -> 经认证 host 管理 -> VM；pinned SSH -> guest 管理/健康
```

Node 不因新增 macOS provider 自己发推理外连。需要完整 Mach-O 产品、依赖、launchd、实际业务 UID、健康/能力握手和认证数据通道。Darwin 目录与文件权限必须使用真实 OS 支持的安全文件操作，不复用 Linux `/proc/.../fd` 假设；跨 VM 不复用共享目录 Unix socket。

沿既有消息、帧、错误、取消、完成与背压契约实现传输，不增加客户端 END/seq/RST 语义。SSH 隧道只是字节运输，不是推理协议重写。缺终止/部分响应仍是失败，不写成功或 HTTP 200；控制通道存活不是 Slot-ready。

inference 阶段 guest 外部网络默认拒绝，仅开放固定代理接入点和受控管理流量，阻断直达 upstream、DNS/其他出口旁路。只有 upstream allowlist 不足以证明代理断开 fail closed。代理/控制失联必须停止调度并按既有契约取消/失败，验证已建立连接也被约束，不能仅阻止新连接。installer 阶段 Apple 下载网络另授权，不能同时加载业务凭据。

x86 的 per-VM 外部网络强制点需要实际验证；VZ NAT 若不能实施相同强制，不认证 A09，不将 bridged/pf 备选写成已支持。显式用户策略与故障直连回退是不同概念，本设计禁止后者。

## 6. 身份观测、clone 与 restore

desired/applied/observed 都带 generation、revision/hash、时间、provider build。每项区分 guaranteed、best_effort、unsupported、not_exposed。只承诺实际可控制且可读回的字段；若签收所需字段不受支持则对应能力未交付，不能把 missing 当通过。

CPU、RAM、OpenCore/SMBIOS、平台 UUID、MAC、磁盘、显示/GPU 按实际 provider 观测。`acceleration=none` 不等于没有仿真显示设备；EDID 没暴露就明确记录。保留虚拟化可见信息，不宣称不可检测，也不把 OS 身份改作 OAuth 身份。

clone 新分配设备标识、MAC、host keys 等，清除应用凭据/受信会话材料并完成重新 pin；guest 原 UID 可以在独立 OS 实例中相同，不借 Linux UID 池解决隔离。不能复制真实机器标识或携带原实例业务凭据上线。

同实例 restore 保持身份，但准入必须同时证明：

1. 旧副本不能继续执行/出站，且不能用旧授权重新启动；
2. 旧磁盘/NVRAM 写能力已撤销，新副本获得独占使用权。

可信宿主管理器必须停止旧资源、持久化禁止旧 epoch 并回收存储 lease；失联时必须有可核验的外部电源/网络隔离加存储写隔离。单次 stop 回执、仅存储 lease、SQLite epoch 或签名人工描述任一单独使用都不足够。无法证明两项时返回 restore_fence_unproven，保持 quarantine，禁止新副本上线。不能通过超时释放预算掩盖旧副本。

## 7. 施工批次与签收

以下是实施顺序，不是已完成清单。每批必须产出真实可运行实现后签收。

| 批次                 | 依赖与真实产物                                                                           | 文件边界（新增均为拟议）                                                       | 失败/回滚与签收                                                            |
| -------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| 1 宿主与锁           | 管理员许可、兼容 Apple 宿主、锁和实测能力/预算                                           | 现有 os-catalog/runtime-kind；新增 macos-compat-lock、macos-admission          | 无批准不启动；配置拒绝/预算冲突实测，不写 supported                        |
| 2 provider           | 批次1；真实 docker-qemu create/inspect/stop/destroy、宿主持久化守卫、私有磁盘/NVRAM/网络 | 现有 vm-runtime/slot-host/provisioning；新增 macos-runtime、macos-host-control | 取消/迟到/quarantine与归属真实验证；只清本实例，不动旧 Linux               |
| 3 guest/account      | 批次2；实际 macOS15安装、Setup Assistant PoC、账号读回、pin和collector                   | 现有 guest-identity-reader/API/UI；新增 macos-account、macos-observation       | 不匹配保持 needs_setup；账号/设备十轮重启稳定；自动初始化另需受测签收      |
| 4 Darwin/出口        | 批次3；完整 Darwin kernel/CLI/OAuth/管理产品、launchd、权限、认证传输及外部 ACL          | 现有 transport/slot-runtime/凭据消费者；私有源/构建遵守 local-src 规则         | 没凭据/失败不调度；真实流/非流/取消/背压/断代理/断控制验证，无直连         |
| 5 clone/restore/销毁 | 前四批；新身份、双条件外部 fence、存储独占转移、按归属清理                               | 现有 vm-recreate/provisioning/生命周期；新增 macos-recovery                    | 旧节点失联/可出站/可写盘均拒恢复；实际 clone/restore/cancel/delete 场景    |
| 6 发布与回归         | 所有批次含自动建 OS/用户 gate 通过                                                       | 现有 API文档、CI、UI与发行清单                                                 | x86 A05–A12、旧 Linux canary升级/回滚、秘密/许可审查全通过，才考虑支持声明 |

永久测试针对可见行为：未知 contract/审批绕过拒绝、幂等规格冲突/旧代隔离、OS-ready 不调度、文件越界拒绝、quarantine 预算不重分配、fatal host key、不满足双重物理证明拒 restore。不能以 source 检查、mock 回声或纯映射测试代替物理签收。

真实宿主必须覆盖 A05 安装/账号，A06 十轮身份，A07 三层硬件，A08 全部 Darwin 产品，A09 完整断代理/控制与旁路，A10 clone/restore，A11 取消/迟到/销毁，A12 检测面。当前这些 macOS 场景全部未运行；本方案与 Linux 证据均不能替代。

## 8. 协作边界

Claude CLI 在项目外临时目录运行，仅接收 macOS 需求、catalog/provider 摘要、已验证阻塞及主进程质询。内置工具/MCP禁用，customization关闭，不读取全仓、不编辑项目；现有认证仅用于调用，不写入讨论材料。

讨论先比较路线，再审查守卫/账号/资源契约，最后反方质询传输与恢复安全。主进程拒绝了无条件 ARM 切换、每代换 handle、仅 DB/存储证明恢复、允许直达上游的 ACL、以及新增客户端帧语义等提议。最终取此文定义的范围与签收，不把设计意见计作实测。

三个成功讨论轮次均由 CLI init 和消息记录核实：`tools=[]`、`mcp_servers=[]`、工具调用为 0。一次初始认证缺失和一次无文本响应不计成功讨论；只复用了现有认证并重试，没有扩大文件权限。仅保存设计回复和隔离摘要，不发布原始 thinking、认证或全仓内容。

## 9. 明确风险

受支持的无人值守 OS/首个管理员初始化路径尚未证实；如果自动初始化 gate 不能通过，完整 macOS 仍未交付，不能永久停在人工流程后宣称完成。host guardian 的签名不能弥补被攻陷/不可信宿主；该情况必须依赖实测外部隔离和存储独占证明。GPU/EDID、出口强制与兼容性不能靠模型名称推断，缺能力则相应签收阻塞。
