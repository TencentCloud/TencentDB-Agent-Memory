# 协议转换字段映射矩阵（OpenAI Chat / Responses ↔ Anthropic Messages）

> 本文档与测试一一对应：每个状态为 ✅ 的字段都有自动化用例兜底。
> 用例数按分支实测（`npm test`，改代码后请同步这里的数字）：
>   - 转换层分支：10 个文件 / 129 用例 —— protocol-conformance.test.ts 61、
>     chat-anthropic-role-rules.test.ts 19、responses-anthropic-compat.test.ts 13、sse.test.ts 8、
>     injection-protocol-conversion.test.ts 8（注入内容跨协议存活 / 可缓存前缀位 /
>     cache_control 不泄漏 / 确定性）、protocol-stream-semantics.test.ts 5、
>     protocol-stats.test.ts 4、protocol-stats-streaming.test.ts 4、sse-fuzz.test.ts 4、
>     responses-sse-completion.test.ts 3；
>   - 协议接线分支：另带 responses-chat-compat.test.ts 10（第一跳 Responses→Chat 的丢参计数 +
>     上游拒收 response_format 时的重试判据）、
>     probe.test.ts 30（上游能力探测：按协议选路 / 注册表完整性 / 按上游去重 / 缓存 / 重探 / 变更告警）、
>     upstream-auth.test.ts 7（上游凭据取值顺序与启动期审计）、
>     token-estimate.test.ts 7、protocol-errors.test.ts 5，共 14 个文件 / 180 用例；
>   - 两支合并：15 个文件 / 194 用例。
> 两支的 `npx tsc --noEmit` 均为 0 错误。
> 注：上游 v2.0.2-beta.1 删除了 base 自带 user-query-extractor 8 个用例（对应旧文档 110/130）。

## 架构

三层组合，中间统一走 Chat：

```text
Responses ↔ Chat ↔ Anthropic
```

- `responses-chat-compat.ts`：Responses ↔ Chat（请求/JSON/SSE）
- `chat-anthropic-compat.ts`：Chat ↔ Anthropic（请求/JSON/SSE）
- `responses-anthropic-compat.ts`：组合层（Responses ↔ Chat ↔ Anthropic 两跳）
- `sse.ts`：统一状态化 SSE 帧解析器（LF/CRLF、紧凑格式、多 data 行、跨 chunk）

## 请求字段矩阵

### Anthropic → OpenAI Chat（`anthropicToChat`）

| 字段 | 映射 | 状态 |
|---|---|---|
| model / max_tokens / temperature / top_p / stream | 直传 | ✅ |
| system（string/blocks） | → 首条 system 消息 | ✅ |
| messages[user].text / image | → content parts | ✅ |
| messages[user].tool_result | → role=tool（含多模态 content） | ✅ |
| messages[assistant].text / tool_use / thinking | → content / tool_calls / reasoning_content | ✅ |
| tools[].input_schema | → tools[].parameters | ✅ |
| tool_choice auto/any/tool:{name} | → auto / required / function:{name} | ✅ |
| tool_choice.disable_parallel_tool_use | → parallel_tool_calls:false | ✅ |
| stop_sequences | → stop | ✅ |
| metadata.user_id | → user | ✅ |
| top_k / thinking / 其它 metadata | 显式丢弃（onDropped 上报） | ✅ |
| thinking.signature | → reasoning_signature（preserveSignature 开） | ✅ |

### OpenAI Chat → Anthropic（`chatToAnthropic`）

| 字段 | 映射 | 状态 |
|---|---|---|
| messages[system / developer] | → system（developer 语义等同 system） | ✅ |
| messages[user]（string/parts/图片） | → text / image 块 | ✅ |
| messages[tool] | → tool_result（含多模态） | ✅ |
| messages[assistant].tool_calls | → tool_use 块（含 reasoning 前置） | ✅ |
| messages[assistant].function_call（legacy） | → tool_use 块 | ✅ |
| tools[] / functions[]（legacy） | → tools[]（input_schema） | ✅ |
| tool_choice none/auto/required/function:{name} | → none 时移除全部 tools（Anthropic 无 none，等价近似）；其余 auto / any / tool:{name} | ✅ |
| parallel_tool_calls:false | → tool_choice.disable_parallel_tool_use | ✅ |
| stop（string/array） | → stop_sequences | ✅ |
| max_tokens / max_completion_tokens | → max_tokens | ✅ |
| user | → metadata.user_id | ✅ |
| logprobs / logit_bias / penalty / seed / n / stream_options | 显式丢弃（onDropped 上报） | ✅ |
| response_format（json_object / json_schema） | 显式丢弃（onDropped 上报；Anthropic Messages 无对位顶层字段，不伪造 prompt 注入） | ✅ |
| reasoning_content / reasoning_signature | → thinking（map + preserveSignature 开） | ✅ |

## 响应字段矩阵

### Anthropic JSON → OpenAI Chat JSON（`anthropicJsonToChatJson`）

| 字段 | 映射 | 状态 |
|---|---|---|
| content[text / thinking / tool_use] | → content / reasoning_content / tool_calls | ✅ |
| thinking.signature | → reasoning_signature（开关开） | ✅ |
| stop_reason end_turn/stop_sequence/refusal/max_tokens/tool_use | → stop / stop / stop / length / tool_calls | ✅ |
| usage input/output/cache_read | → prompt/completion/cached_tokens | ✅ |

### OpenAI Chat JSON → Anthropic JSON（`chatJsonToAnthropicJson`）

| 字段 | 映射 | 状态 |
|---|---|---|
| message.content / reasoning_content / tool_calls / function_call | → text / thinking / tool_use 块 | ✅ |
| finish_reason stop/content_filter/length/tool_calls/function_call | → end_turn / end_turn / max_tokens / tool_use / tool_use | ✅ |
| usage prompt/completion/cached | → input/output/cache_read_input | ✅ |

### Responses ↔ Chat

| 字段 | 映射 | 状态 |
|---|---|---|
| instructions / developer / system | → system 消息 | ✅ |
| input.message / function_call / function_call_output | → user/assistant / tool_calls / tool | ✅ |
| input.reasoning.summary（官方数组或字符串形态） | → assistant.reasoning_content | ✅ |
| output.reasoning（summary 数组/字符串兼容） | → reasoning_content → reasoning item（`summary: [{type:"summary_text",text}]`） | ✅ |
| tool_choice（Responses） | → Chat tool_choice | ✅ |
| text.format（text / json_object（legacy JSON mode）/ json_schema；json_schema 保留 name/description/schema/strict，name 缺省补 "response"） | → response_format | ✅ |
| response_format（Chat） | → text.format（反向：json_object → legacy JSON mode；json_schema 保留 description） | ✅ |

## 流式事件矩阵

| 上游事件 | 下游事件 | 状态 |
|---|---|---|
| Anthropic message_start / content_block_start / text_delta / input_json_delta / thinking_delta / signature_delta / message_delta / message_stop / error | OpenAI chat chunk（content / tool_calls / reasoning_content / reasoning_signature / finish_reason / usage / error） | ✅ |
| OpenAI chat chunk / usage 尾帧 / [DONE] / error | Anthropic content_block_* / message_delta / message_stop / error | ✅ |
| Responses response.* / output_item.* / response.completed / response.failed | Chat chunk / usage / [DONE] / error | ✅ |
| Chat chunk / [DONE] / error | Responses response.created / output_item / response.completed / error | ✅ |

### 流式 reasoning 补充（`response.reasoning_summary_text.delta`）

| 上游事件 | 下游事件 | 状态 |
|---|---|---|
| Chat delta.reasoning_content | Responses output_item.added(reasoning) / reasoning_summary_part.added / reasoning_summary_text.delta | ✅ |
| Responses reasoning_summary_text.delta | Chat delta.reasoning_content | ✅ |

Responses reasoning item 按官方结构输出 `summary: [{ type: "summary_text", text }]`；
输入侧同时兼容官方数组与部分上游的字符串形态。

### legacy functions / 连续 user 消息（Anthropic 400 防护）

- `role="function"` 结果消息按 function name 与前面 assistant `function_call` 生成的
  `tool_use` id 配对成 `tool_result`（无配对时降级为普通文本）。
- Chat→Anthropic 相邻 user 消息合并为一条，`tool_result` 块前置再跟文本，
  满足 Anthropic roles 严格交替约束（tool 结果 + 后续提问不再触发 400）。

流式不变量（测试覆盖）：message_start 至多一次、每个块成对 open/stop、message_delta/message_stop 至多一次、错误帧后不再发 [DONE]/message_stop；
**tool index 重映射**：Anthropic content block index（thinking/text 也会占位）→ chat tool_calls 连续序号 0..n-1，
不会把上游块 index 泄漏成跳号；
**空内容流合法**：Chat→Anthropic 流即使只有 finish_reason/[DONE] 或直接 EOF，也先发 message_start
再收 message_delta/message_stop，不产生缺头的非法 SSE 流；
**错误透传对称**：Anthropic/Chat/Responses 三个方向的流式错误（error 事件 / 内联 error 帧 / response.failed）都会透传给客户端，不再静默吞掉。

## 设计决策与边界

- **thinking 默认 strip、map 可选**：无 signature 的 thinking 块会被严格 Anthropic 上游拒绝，故 Chat→Anthropic 默认不产生 thinking；需要时 `opts.thinking:"map"`。
- **signature 保真默认关**：`preserveSignature` 会在 chat 消息上带 `anthropic_reasoning_signature` 自定义字段，转发严格 OpenAI 上游前需剥离。
- **reasoning 方向说明**：Anthropic→Chat/Responses 与 Chat↔Responses 的 reasoning 双向完整透传；
  Chat/Responses 上游的 reasoning 到 Anthropic 客户端默认 strip（无 signature 的 thinking 会破坏严格
  Anthropic 上游），只有显式开启 map 且带签名时才输出 thinking 块——这是安全默认，不是漏映射。
- **丢弃参数可观测**：`onDropped` 回调上报所有“协议无对位”的参数（logprobs/penalty/seed/top_k/thinking 等），杜绝静默丢失。
- **SSE 健壮性**：统一解析器支持 CRLF、`event:xxx`/`data:xxx` 紧凑格式、多 data 行、跨 chunk 缓冲、注释行与 [DONE]。
- **round-trip 语义保真**：确定性随机属性测试证明 Anthropic→Chat→Anthropic 与 Chat→Anthropic→Chat 的角色序列、tool_call_id 配对、thinking/text/tool 内容不丢失。
- **转换器确定性**：同输入两次转换字节一致（显式 id 场景），是上游 prompt 缓存命中的前提。

## 已知边界（设计取舍，非缺陷）

- **backpressure**：转换器为同步 emit 架构，写入侧不感知下游背压；单流内存与上游 chunk
  速率相关，超长尾大流可能积压。改进方向是异步队列 + `desiredSize` 感知，但会引入复杂度，
  当前取舍为保持同步简单性。
- **`n > 1` 多候选**：Anthropic Messages 单响应，OpenAI `n > 1` 多候选无法表示；转换取
  `choices[0]`，其余丢弃（协议层能力边界，非实现缺陷）。
- **非流式错误 JSON**：由传输层 `HTTP status >= 400` 拦截（`codexHandler` / `workbuddyHandler`
  的 forward 路径），错误体不会进入转换器；转换器保持纯函数。
- **usage 细分字段**（`cache_creation_input_tokens` / `completion_tokens_details.reasoning_tokens`）：
  对方协议无对位字段，保持聚合计数（output_tokens 已含 reasoning），不伪造细分。
- **内容块级无对位字段**（Anthropic user 的 `cache_control` / `document`、Responses 的 custom tools、未知 content block 类型）：当前静默跳过；`onDropped` 只覆盖顶层参数，内容块级丢弃未逐块上报（如需要可再下沉到块级）。
- **多模态仅图片**：Anthropic↔Chat/Responses 的 image 双向映射已覆盖；Anthropic `document`、
  OpenAI Chat `input_audio` / 文件上传、Responses `input_file` 等对方协议无对位字段，统一按
  “内容块级无对位字段”显式跳过（不伪造 data URL / base64 语义），如需支持需上游先提供文件输入能力。
- **辅助端点只同协议透传**：`/v1/messages/count_tokens`、`/v1/embeddings`、`/v1/completions`、
  `/v1/moderations` 走 whitelist 透传，仅在 upstream 同协议时可用；05A（Claude Code → Chat 上游）
  下 count_tokens 预检由接线层本地计算兜底（口径与实测偏差见下节），不走转换器。
- **Responses 会话状态/compact 端点**：`input/output_conversation_state`、`/responses/compact` 依赖
  Responses 原生会话状态语义，Responses→Chat/Anthropic 转换路径无法映射，仅支持 Responses 上游
  直连；转换场景下应在接入层显式报“不支持该端点”而不是透传 404。
- **Responses→Chat 输出上限钳制**：`responses-chat-compat.ts` 对 `max_output_tokens` / `max_tokens`
  默认按智谱口径钳到 32768（`DEFAULT_MAX_TOKENS_CAP`）；调用方可用 `opts.maxTokensCap` 按
  上游覆盖（不传即沿用历史默认）。**截断不再静默**：真正发生钳制时会计入
  `/metrics` 的丢弃参数计数（`max_tokens_clamped`），便于发现"请求被悄悄改小"。
  若后续要做成 per-upstream 配置，只需在 handler 接线处传入 `maxTokensCap`。
- **协议无对位参数**（logprobs / penalty / seed / top_k / thinking 等）：通过 `onDropped`
  显式上报，调用方可记录；默认静默但可观测。
- **结构化输出到 Anthropic 侧**：Anthropic Messages 无 `response_format` / `text.format`
  顶层对位字段，Chat→Anthropic 及两跳 Responses→Chat→Anthropic 显式丢弃并 `onDropped`
  上报，不伪造 prompt 注入；Responses↔Chat 之间 json_object / json_schema 双向完整映射
  （json_schema 保留 description，name 缺省补 "response"）。若上游为支持 Anthropic 原生
  JSON Schema 输出字段的服务，可在接线层按 per-upstream 开关启用，避免向不支持的兼容
  上游发送未知字段触发 400。

## 接线层实现说明（PR #1253）

### count_tokens 兜底口径与实测偏差（05A / 05B：token 计算差异）

Claude Code 每轮先打 `/v1/messages/count_tokens` 预检上下文用量；当上游被转成 Chat /
Responses 时该端点不存在，由 `src/common/token-estimate.ts` 本地计算后应答
（只用于客户端上下文条提示，**计费仍以上游 usage 为准**）。

口径取 tiktoken `cl100k_base`，与仓库内既有实现对齐：
`MemoryCore/src/offload/fast-token-estimate.ts` 声明该编码覆盖 GPT-4 / Claude /
DeepSeek / GLM / MiniMax，`MemoryCore/src/offload-client/token-estimator.ts` 亦以
tiktoken 为主路径。tiktoken 不可用时退回 CJK 感知启发式，保证接口不抛错、不返回 0。

原实现为「序列化字符数 / 4 + 每条消息 16 字符」，实测偏差（10 类场景，真值取
tokenizer + 4 × 消息数）：

| 场景 | 旧 chars/4 | 旧偏差 | 新口径 | 新偏差 |
|---|---|---|---|---|
| 中文短提问（99 字符） | 36 | **−58%** | 87 | +2% |
| 中文长文档（387 字符） | 109 | **−68%** | 343 | +1% |
| 英文长文档（698 字符） | 186 | +42% | 133 | +2% |
| Python 代码（775 字符） | 216 | +13% | 194 | +1% |
| TypeScript 代码（545 字符） | 152 | +5% | 147 | +1% |
| 工具定义 + system（685 字符） | 183 | +3% | 178 | +0% |
| 中英混合对话（159 字符） | 97 | −19% | 129 | +8% |
| 长会话 20 轮（1320 字符） | 558 | −50% | 1150 | +4% |
| Claude Code 风格（1186 字符） | 322 | −41% | 548 | +0% |
| 纯 ASCII 日志（3174 字符） | 811 | −17% | 980 | +0% |

复现：`node --import tsx/esm scripts/qa/token-estimate-vs-upstream.mjs --baseline`。

**已知边界**：cl100k 与 o200k 都不是「上游真值」——各厂商 tokenizer 不同，二者之差
即跨厂商口径差（中文场景 o200k 比 cl100k 少 ~30%，脚本同时输出两个参考供对照）。
实现取 cl100k，在中文上偏保守：宁可让客户端早提示压缩，也不要让它以为还有空间。

- **请求/响应头过滤已收敛**：`MemoryProxy/src/upstream/headers.ts` 是唯一实现；
  Chat / Anthropic / Codex / WorkBuddy 四个 handler 统一从这里引入
  `SKIP_REQUEST_HEADERS` / `filterResponseHeaders`，不再各写一份。
- **Per-agent 转换开关 true / false 都显式生效**：`chatCompletions`、
  `anthropicToChat`、`chatToAnthropic`、`responsesToAnthropic`、
  `anthropicToResponses` 配置 `true` 表示启用；配置 `false` 表示明确禁用，
  并且只要某个 agent 显式配置过任一开关，`autoDetect` 就不会再为该 agent
  自动补其它开关（用户意图优先）。

## 测试覆盖

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| protocol-conformance.test.ts | 61 | thinking/signature/tool_choice/stop/parallel/error/finish_reason/user/多模态/legacy functions/onDropped/developer/round-trip/Responses 错误透传/确定性 + 流式 tool index 重映射/cache 统计字段/none 语义/空内容流 message_start/丢参计数/结构化输出（text.format ↔ response_format，含 legacy json_object 与 description） |
| sse.test.ts | 8 | 解析器健壮性（LF/CRLF/紧凑/多 data/注释/跨 chunk/[DONE]） |
| sse-fuzz.test.ts | 4 | 模糊测试：随机输入不崩、任意切分不吞帧、多块拼接一致、1MB 大帧不截断 |
| protocol-stats.test.ts | 4 | 性能统计：分位数/环形上限/缓存命中/Prometheus 导出 |
| responses-anthropic-compat.test.ts | 13 | 组合层两跳 + usage 单次统计 + 并行工具回归 |
| protocol-stats-streaming.test.ts | 4 | 流式收尾 usage/cache 计入 /metrics（单跳与组合层均只计一次） |
| protocol-stream-semantics.test.ts | 5 | 请求体转换的 stream:false/true 透传语义 |
| responses-sse-completion.test.ts | 3 | 仅 output_item.done（无 delta）时兜底补发 arguments/text/summary |
| chat-anthropic-role-rules.test.ts | 19 | 角色严格交替（相邻同角色合并）+ tool_use/tool_result 相邻配对 + 消息形状兜底（首条 user / 悬空 tool_use / 空 content / 无 user 时兜底） |
| injection-protocol-conversion.test.ts | 8 | 注入 × 转换接缝：注入恰好存活一次、落在可缓存前缀位、不泄漏 cache_control、转换确定性，含 Responses 合成体装配 |

### 协议接线分支额外测试（该分支合计 14 个文件 / 180 用例）

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| token-estimate.test.ts | 7 | count_tokens 本地口径（正常/超长/异常输入归一，不抛错）+ 3 条口径回归（中文 100 字≈131、同字符数中文/ASCII 比值>8、英文 440 字≈97） |
| protocol-errors.test.ts | 5 | 接线层协议错误/非流式路径（HTTP 状态拦截、错误体不进入转换器） |
| upstream-auth.test.ts | 7 | 上游凭据取值顺序（agent.apiKey → upstream.apiKey → 客户端 key）、passthroughClientKey 显式透传、启动期审计的三类提示 |
| probe.test.ts | 30 | autoDetect：按协议选路（既有 4 个客户端 8 种能力组合与改造前逐组合一致）+ 注册表完整性（每个 kind 都声明合法原生协议）+ 未声明协议不给开关只告警 + 待探集合由注册表派生 + 显式 true/false 都跳过探测；同一上游多客户端只探一次（按 url 去重）；能力回退时撤销上一轮开关、显式配置不被覆盖、三端点全不通保留旧结论、未过期缓存跳过探测、缓存损坏容错、定期重探启停 |
| responses-chat-compat.test.ts | 10 | 第一跳丢参计数：可完整映射的请求零丢弃；宿主侧 item（item_reference / local_shell_call / 未知类型归 other）与文件、音频 content part 按类型计数；`store` / `previous_response_id` / `include` / `reasoning` 等 Responses 独有顶层参数逐项计数；非 function 工具计数；上游拒收 `response_format` 时的重试判据（400 + 发过该字段 + 文案点名才重试） |
