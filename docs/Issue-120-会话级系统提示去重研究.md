# Issue 120：会话级系统提示去重研究

## 结论

这里的“去重”不能理解成插件从第二轮开始少发 system prompt。

在当前架构下，插件不直接控制最终 provider 请求体。OpenClaw / adapter 仍然需要把完整 system prompt、工具定义、历史消息和当前用户输入交给模型。插件如果只因为“同一 session 已经发过”就省略 system prompt，会改变模型实际看到的上下文；这不是缓存优化，而是语义变化。

可落地的边界是：

1. 稳定内容保持在 prompt 前缀：基础 system prompt、工具 schema、L3 persona、L2 scene navigation、memory tools guide。
2. 动态内容放到尾部：当前轮 L1 recall、用户 prompt、临时工具结果。
3. 不把动态 recall 写回历史，避免下轮污染稳定前缀。
4. provider 支持缓存时，依赖相同前缀命中缓存；插件侧只负责让前缀尽量稳定。
5. 如果 host/provider 支持显式缓存控制，可以在 host 层加 `prompt_cache_key` 或 Anthropic `cache_control`，但这不是插件层删除 system prompt。

## 外部依据

### OpenAI / Responses API

OpenAI prompt caching 文档说明：

- Prompt caching 自动启用，不需要业务代码显式创建缓存。
- 命中依赖 prompt 的 exact prefix match。
- 静态内容应放在 prompt 开头，变量内容放在后面。
- 1024 tokens 以上才有缓存收益；usage 中会返回 `cached_tokens`，低于门槛时为 0。
- `gpt-5.5` 支持 extended prompt cache retention。

资料：

- <https://platform.openai.com/docs/guides/prompt-caching>

Conversation state 文档说明：

- Responses API 可以用 `previous_response_id` 或 Conversations 管理状态。
- `store=false` 时，官方示例走的是手动维护 history，并把需要保留的 response output / encrypted reasoning items 回传。
- 使用 `previous_response_id` 的链式状态仍会把链上先前输入 token 计入 input tokens。

资料：

- <https://developers.openai.com/api/docs/guides/conversation-state>

对本项目的含义：

- 不能假设 `disable_response_storage=true` 时可以靠 provider 保存 session system prompt。
- 在 `store=false` 路径上，插件仍应按无状态请求处理：每轮构造完整上下文。
- 对 OpenAI-compatible Responses provider，可研究 host 层是否能透传 `prompt_cache_key` / `prompt_cache_retention`；插件层不应删 system prompt。

### DeepSeek

DeepSeek Context Caching 文档说明：

- Context caching 默认启用。
- 后续请求和前序请求存在 overlapping prefixes 时，重叠部分可以命中缓存。
- cache hit 需要完整匹配已经持久化的 cache prefix unit。
- usage 中提供 `prompt_cache_hit_tokens` 和 `prompt_cache_miss_tokens`。

资料：

- <https://api-docs.deepseek.com/guides/kv_cache>

对本项目的含义：

- DeepSeek 的优化点是维持相同 prefix，而不是省略 prefix。
- 如果 system prompt 里混入当前轮 recall、时间戳、随机顺序或调试内容，会破坏 prefix 命中。

### Anthropic Messages / Anthropic-compatible endpoint

Anthropic prompt caching 文档说明：

- 可以在共享 block 上放 `cache_control` breakpoint。
- 典型用法是对 shared system prompt 或 tool definitions 预热。
- usage 中用 `cache_creation_input_tokens` 和 `cache_read_input_tokens` 观察写入和读取。
- cache 有 TTL；需要按 TTL 预热或保持请求连续。

资料：

- <https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching>

对本项目的含义：

- Anthropic 方向可以做显式缓存 breakpoint，但要在最终 provider 请求层实现。
- 插件返回 `appendSystemContext` 时无法保证 host 会把它拆成独立 block，也无法单独挂 `cache_control`。
- DeepSeek 的 Anthropic-compatible endpoint 是否完整支持 `cache_control`，需要用真实请求确认。

## 当前仓库状态

当前实现已经做了有利于缓存的拆分：

- `src/core/hooks/auto-recall.ts` 把 L3 persona、L2 scene navigation、memory tools guide 放入 `appendSystemContext`。
- 同文件把当前轮 L1 recall 放入 `prependContext`，靠近用户 prompt。
- `index.ts` 在 `before_message_write` 默认清理 `<relevant-memories>`，避免 dynamic recall 进入持久化历史。
- `src/offload/state-manager.ts` 只缓存 system prompt 和 token count，用于估算和压缩判断，不用于少发 system prompt。

这个边界是合理的。它保证模型每轮仍能看到完整 system prompt，同时让 provider 有机会复用稳定前缀。

## 不建议做的方案

### 方案：session 内只发一次 system prompt

不建议。

原因：

- Chat Completions / DeepSeek 无状态请求每轮都需要完整 messages。
- Responses API 在 `store=false` 下不能假设 provider 持有上一轮完整上下文。
- Anthropic Messages API 也不是“发一次 system prompt 后省略”的语义；显式缓存只是缓存 KV，不改变请求中共享内容的逻辑位置。
- 如果插件直接省略 system prompt，下游模型会少看约束、工具说明和 memory 使用边界。

### 方案：把系统提示摘要写入 session digest，再用 digest 替代正文

不建议作为默认行为。

digest 可以作为 trace / metrics / cache key，但不能替代模型需要阅读的指令正文。除非 host/provider 有明确的 server-side state 语义，并且请求协议保证 digest 能解析到原文，否则这会改变行为。

## 可做的优化

### A. 稳定 system prompt 的内容和顺序

保持 `appendSystemContext` 的顺序固定：

```text
persona
scene navigation
memory tools guide
```

避免把下面内容放进 `appendSystemContext`：

- 当前时间戳。
- 当前用户问题。
- 当前轮 L1 recall。
- 随机排序的候选列表。
- debug / trace 文本。

### B. host 层透传缓存 hint

如果 OpenClaw / adapter 后续支持 provider 参数，可考虑：

- OpenAI-compatible Responses：透传稳定的 `prompt_cache_key`，建议按 agent id / workspace id / system prompt digest 生成。
- OpenAI `gpt-5.5`：明确设置 `prompt_cache_retention: "24h"`，前提是 provider 兼容。
- Anthropic-compatible：把稳定 system prompt / tool definitions 拆为 block，并在最后一个共享 block 加 `cache_control`。

这些参数应在最终请求层实现。插件只返回字符串时，不适合假装自己控制了 provider cache breakpoint。

### C. 本地只缓存构造结果，不改变 API 输入

可以本地缓存 `appendSystemContext` 的 digest 和拼接结果，减少重复字符串构造、日志噪音和 token 估算开销。

这个优化不会降低 provider input tokens，也不会提高缓存命中率；收益只在插件 CPU 和日志层。优先级低于保持 prompt 前缀稳定。

### D. 对 memory tools guide 的注入条件再评估

当前逻辑是：只要有 persona / scene / L1 recall，就把 `memory-tools-guide` 加入 `appendSystemContext`；如果某轮没有任何 recall/persona/scene，就不加。

这会让 system prompt 在“有 recall”和“无 recall”的轮次之间发生切换。是否要改成 recall enabled 时始终注入 guide，需要看真实会话：

- 优点：system prompt 更稳定，工具使用边界更一致。
- 缺点：无 memory 上下文的轮次也会多带一段固定说明，增加输入 tokens。

建议先测量再改默认值。

## 真实测试设计

新增临时脚本：

- `tmp/session-system-prompt-cache-probe.mjs`

脚本只从环境变量读取 key，不写入仓库，不打印 key，不保存原始响应。输出只包含 usage 聚合字段。

### Pixel / Responses API

目标配置：

```text
base_url=https://api.ai-pixel.online
wire_api=responses
model=gpt-5.5
reasoning.effort=xhigh
store=false
```

测试组：

1. `stable-1`：稳定 system prompt + 用户输入 1。
2. `stable-2`：同一 system prompt + 用户输入 2。
3. `stable-3`：同一 system prompt + 用户输入 3。
4. `changed-system`：改动 system prompt。
5. `stable-4`：恢复第一组 system prompt。

观察指标：

- `input_tokens`
- `input_tokens_details.cached_tokens`
- `miss_tokens = input_tokens - cached_tokens`
- `cache_hit_ratio`

预期：

- 第 2/3 轮应比第 1 轮有更多 cached tokens。
- `changed-system` 应明显降低命中。
- 恢复稳定 prompt 后，命中情况取决于 provider cache retention 和路由。

### DeepSeek Anthropic-compatible

目标配置：

```text
base_url=https://api.deepseek.com/anthropic
model=DeepSeek-V4-pro[1m]
```

测试组同上，但在 system block 上加：

```json
{ "cache_control": { "type": "ephemeral" } }
```

观察指标：

- `input_tokens`
- `cache_creation_input_tokens`
- `cache_read_input_tokens`
- `total_input_tokens`
- `cache_read_ratio`

预期：

- 如果 endpoint 支持 Anthropic cache_control，第一轮应出现 cache creation，后续稳定轮应出现 cache read。
- 如果 endpoint 忽略或不支持 cache_control，可能只有普通 input tokens 或返回参数错误。

## 当前测试状态

2026-07-02 本地执行：

```text
node tmp/session-system-prompt-cache-probe.mjs
```

结果：

```text
pixel_responses: skipped，缺少 PIXEL_API_KEY/OPENAI_API_KEY
deepseek_anthropic: skipped，缺少 ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY
```

为了避免把用户提供的 token 写入命令行、审批记录或仓库文件，当前没有直接在 shell 命令里注入密钥。后续可以由调用环境设置环境变量后直接复跑脚本。

复跑方式：

```powershell
$env:PIXEL_API_KEY = "<redacted>"
$env:PIXEL_BASE_URL = "https://api.ai-pixel.online"
$env:PIXEL_MODEL = "gpt-5.5"
$env:PIXEL_REASONING_EFFORT = "xhigh"
node tmp\session-system-prompt-cache-probe.mjs
```

只跑 Pixel：

```powershell
$env:PROBE_ONLY = "pixel"
node tmp\session-system-prompt-cache-probe.mjs
```

只跑 DeepSeek Anthropic-compatible：

```powershell
$env:ANTHROPIC_AUTH_TOKEN = "<redacted>"
$env:ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic"
$env:ANTHROPIC_MODEL = "DeepSeek-V4-pro[1m]"
$env:PROBE_ONLY = "anthropic"
node tmp\session-system-prompt-cache-probe.mjs
```

## 阶段判断

目前可以确定：

- 插件层不应做“省略 system prompt 正文”的 session 级去重。
- 当前实现的 stable / dynamic 拆分方向正确。
- 真正影响 provider 缓存的是 prompt 前缀稳定性和 provider 缓存能力。
- OpenAI / DeepSeek / Anthropic 官方文档都支持“稳定前缀优先”的设计边界。

尚未完成：

- Pixel Responses API 在 `store=false`、`gpt-5.5`、`xhigh` 下的真实 cached token 数据。
- DeepSeek Anthropic-compatible endpoint 对 `cache_control` 的真实兼容性。
- `memory-tools-guide` 是否应始终注入的 A/B 数据。
