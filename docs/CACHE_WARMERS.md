# 缓存续期插件兼容性

本次分析使用的上游源码：

- [omp-cache-warmer](https://github.com/blingdivinity/omp-cache-warmer/tree/fa86ec855ab4d8807f41be25668f7cfe0265daf2)，提交 `fa86ec855ab4d8807f41be25668f7cfe0265daf2`。
- [pi-warm-cache](https://github.com/ribbons-digital/pi-warm-cache/tree/dbd9c6d2f29e51beff72882a8d867c49300bd039)，提交 `dbd9c6d2f29e51beff72882a8d867c49300bd039`。
- 本地 `X:/oh-my-pi` 的 provider、cache warmer 和 extension API 源码。

## 实际请求

`omp-cache-warmer` 有两条路径。独立 daemon 复制会话文件，调用 `omp -r <副本> -p "Respond with only: OK"`，并设置 `PI_CACHE_RETENTION=long`；原会话关闭后仍可运行。live-warm extension 则在打开的会话闲置期间发送相同短指令，等待完成后回退会话树，保持下一条真实消息使用原前缀。这两条路径都经过普通会话请求流程；回复指令很短不等于设置了 `max_tokens=1`。

`pi-warm-cache` 捕获 `before_provider_request` 的真实 payload，在 `agent_settled` 后启动定时器，调用 `modelRegistry.complete({ onPayload })` 重放该 payload。Anthropic 路径保留 system、tools、messages、thinking 和 cache_control，只缩小输出预算；enabled thinking 的合法下限是 `budget_tokens + 1`。`session_shutdown` 会停止定时器并销毁状态。

因此“会话停止”需要区分一轮回答结束和整个客户端退出。第二个插件不会在客户端退出后继续续期。

## 网关处理

适配前，默认开启的 `health_probe.intercept_warmup` 有两个误判入口：

- `claude-cli` UA + Haiku + `max_tokens=1` 在检查 tools 之前返回 `haiku_ping` 模拟响应。
- 无 tools、全数组形态的请求，历史中出现精确 `Warmup`、标题请求或末条 suggestion 指令时可能被模拟响应短路。

`omp-cache-warmer` 默认短指令通常不会命中。`pi-warm-cache` 的 Haiku 最小重放如果使用 Claude CLI UA 会命中；其他模型／UA 是否命中取决于实际 payload。模拟响应没有上游调用，不能续期 provider 缓存。另外，`compatibility.min_max_tokens` 默认会把小预算提高到 128，增加本来只为续期而发的输出。

现在，顶层、system、tools 或 messages 内容块存在有效 `cache_control: {type: "ephemeral"}` 时，请求跳过预热模拟响应；支持省略 TTL、`5m` 和 `1h`。同一判定使输出下限改为 1，保留合法的调用方小预算；enabled thinking 仍须大于原预算。metadata、工具 JSON schema 中引用的同名字段、非法 TTL 和 thinking 块上的标记不会触发此例外。

缓存请求仍经过鉴权、内容限制、账号额度、并发和正常调度。号池不可用或真实上游失败时返回真实错误。没有缓存标记的普通探活保留原拦截与输出下限。

网关沿用已有的会话黏性、TTL pin 和普通 cli-hop 断点规则；原请求和续期请求都经过相同整流流程。Node 会重建消息断点，native CLI 会生成 system/tools 断点，因此这里不承诺把客户端 payload 逐字原样送上游。不要在续期期间改变模型、账号、persona、thinking 或会话历史，否则可能冷写缓存。独立 daemon 恢复的临时会话也需要核对账号和前缀是否仍与实际使用的会话一致。

## oh-my-pi 宿主限制

本地 oh-my-pi 有内置 cache warmer：重放上一请求并设 `maxTokens=1`，在收到生成块后取消。此次网关适配同样覆盖它的缓存标记请求。

上面固定版本的 `pi-warm-cache` 还要求 `agent_settled` 事件和 `ctx.modelRegistry.complete()`；当前本地 oh-my-pi 的事件与 ModelRegistry 接口不提供它们。包名兼容 shim 不会自动补齐这些 API，网关放行不代表该插件能直接在当前 oh-my-pi 里工作。

在原生 Pi 宿主中，插件还会验证 provider 能力。自定义 Anthropic baseUrl 不能直接继承官方 endpoint 的自动续期能力；插件要求明确的 Anthropic cache-marker metadata。启用了 budget-based thinking 的请求也会关闭自动续期。应以插件的 capability 状态确认是否真正启动 timer，不能把客户端未发请求误判为网关拦截。

## 验证边界

- 单元测试覆盖带缓存的 Haiku／标题／Warmup／suggestion 放行、标记位置与非法标记、最小输出预算和 thinking 合法下限。
- Messages handler 集成测试开启预热拦截，验证带缓存请求进入正常出站组装、保留预算／TTL，真实失败不会变为模拟成功；无标记探活不占用上游。
- `test/e2e/cli-hop-max-tokens.e2e.test.mjs` 使用本机已交付的 native CLI ELF 和 localhost SSE fixture，验证最终请求携带 1／16 token 预算、1h 消息断点，并透传 fixture 的缓存 usage 和 `max_tokens` 终止原因。

localhost fixture 验证转发契约，不证明真实 Anthropic 缓存已经续期。真实效果需在同一账号／模型／会话连续请求中检查 `cache_read_input_tokens`、`cache_creation_input_tokens` 和下一轮真实对话命中情况。
