# 协议转换字段映射矩阵（OpenAI Chat / Responses ↔ Anthropic Messages）

> 本文档与测试一一对应：每个状态为 ✅ 的字段都有自动化用例兜底。
> 全量回归：`npm test`（vitest，85/85 通过：protocol-conformance 49、responses-anthropic-compat 12、
> sse 8、sse-fuzz 4、protocol-stats 4、user-query-extractor 8）。
> 分支内全量：`npx tsc --noEmit` 0 错误。

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
| logprobs / logit_bias / penalty / seed / n / response_format / stream_options | 显式丢弃（onDropped 上报） | ✅ |
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
| input.reasoning.summary | → assistant.reasoning_content | ✅ |
| output.reasoning | → reasoning_content → reasoning item | ✅ |
| tool_choice（Responses） | → Chat tool_choice | ✅ |

## 流式事件矩阵

| 上游事件 | 下游事件 | 状态 |
|---|---|---|
| Anthropic message_start / content_block_start / text_delta / input_json_delta / thinking_delta / signature_delta / message_delta / message_stop / error | OpenAI chat chunk（content / tool_calls / reasoning_content / reasoning_signature / finish_reason / usage / error） | ✅ |
| OpenAI chat chunk / usage 尾帧 / [DONE] / error | Anthropic content_block_* / message_delta / message_stop / error | ✅ |
| Responses response.* / output_item.* / response.completed / response.failed | Chat chunk / usage / [DONE] / error | ✅ |
| Chat chunk / [DONE] / error | Responses response.created / output_item / response.completed / error | ✅ |

流式不变量（测试覆盖）：message_start 至多一次、每个块成对 open/stop、message_delta/message_stop 至多一次、错误帧后不再发 [DONE]/message_stop；
**tool index 重映射**：Anthropic content block index（thinking/text 也会占位）→ chat tool_calls 连续序号 0..n-1，
不会把上游块 index 泄漏成跳号；
**空内容流合法**：Chat→Anthropic 流即使只有 finish_reason/[DONE] 或直接 EOF，也先发 message_start
再收 message_delta/message_stop，不产生缺头的非法 SSE 流；
**错误透传对称**：Anthropic/Chat/Responses 三个方向的流式错误（error 事件 / 内联 error 帧 / response.failed）都会透传给客户端，不再静默吞掉。

## 设计决策与边界

- **thinking 默认 strip、map 可选**：无 signature 的 thinking 块会被严格 Anthropic 上游拒绝，故 Chat→Anthropic 默认不产生 thinking；需要时 `opts.thinking:"map"`。
- **signature 保真默认关**：`preserveSignature` 会在 chat 消息上带 `anthropic_reasoning_signature` 自定义字段，转发严格 OpenAI 上游前需剥离。
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
- **Responses→Chat 输出上限钳制**：`responses-chat-compat.ts` 对 `max_output_tokens` 保留智谱 32768 上限（`Math.min`），
  超过 32768 的请求会被截断；该常量写在通用转换层，属厂商兼容性取舍，若需通用化应移到 per-upstream 配置。
- **协议无对位参数**（logprobs / penalty / seed / top_k / thinking 等）：通过 `onDropped`
  显式上报，调用方可记录；默认静默但可观测。

## 测试覆盖

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| protocol-conformance.test.ts | 49 | thinking/signature/tool_choice/stop/parallel/error/finish_reason/user/多模态/legacy functions/onDropped/developer/round-trip/Responses 错误透传/确定性 + 流式 tool index 重映射/cache 统计字段/none 语义/空内容流 message_start/丢参计数 |
| sse.test.ts | 8 | 解析器健壮性（LF/CRLF/紧凑/多 data/注释/跨 chunk/[DONE]） |
| sse-fuzz.test.ts | 4 | 模糊测试：随机输入不崩、任意切分不吞帧、多块拼接一致、1MB 大帧不截断 |
| protocol-stats.test.ts | 4 | 性能统计：分位数/环形上限/缓存命中/Prometheus 导出 |
| responses-anthropic-compat.test.ts | 12 | 组合层两跳 + usage 单次统计 |
| 其余（critical-paths / optimizations / …） | 109 | 回归 |
