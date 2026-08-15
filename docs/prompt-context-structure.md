# Memory 注入后的 Prompt 上下文结构

本文档解释：当本插件（TencentDB Agent Memory）完成记忆注入后，最终发送给 LLM 的完整上下文长什么样、各部分从哪来、由哪段代码构造。

## 总览：两条注入链路

插件对上下文的影响分为两条独立链路：

| 链路 | 作用对象 | 机制 | 入口代码 |
|---|---|---|---|
| 长期记忆召回（L1/L2/L3） | system prompt + 当前用户消息 | 通过 `before_prompt_build` hook 返回 `appendSystemContext` / `prependContext` / `appendContext` 字段，**由 OpenClaw 宿主拼接**，插件不直接改 messages | `index.ts:530` → `src/core/hooks/auto-recall.ts:80` |
| 短期记忆 / context-offload | messages 数组本身 | **原地修改 `event.messages`**：替换 tool_result 为摘要、删除消息、插入 MMD 消息 | `src/offload/index.ts:268` → `src/offload/hooks/before-prompt-build.ts:43` |

## 注入后的整体结构

以默认配置（`recall.injectionMode = "prepend"`）为例，一轮请求发给 LLM 的上下文结构如下：

```
┌─ system prompt（OpenClaw 原始系统提示词）
│   │
│   └─ appendSystemContext（稳定部分，追加在末尾，利于 prompt cache）
│        ├─ <user-persona>…</user-persona>            ← L3 用户画像（persona.md）
│        ├─ <scene-navigation>…</scene-navigation>    ← L2 场景记忆索引（仅索引，全文需 read_file）
│        ├─ <memory-tools-guide>…</memory-tools-guide>← 记忆工具调用指南
│        └─ [<l4_skill_result>…</l4_skill_result>]    ← offload L4 skill 沉淀（可选）
│
├─ messages[]（历史消息，可能已被 offload 修改）
│   ├─ 原始 user / assistant 消息
│   ├─ 被 offload 的 tool_result：
│   │     "[Offloaded Tool Result | node: N7]
│   │      Summary: …
│   │      result_ref: … (read this file for full tool call and raw result)"
│   ├─ 被 aggressive/emergency 压缩整段删除的消息（不存在了）
│   └─ { role: "user", <history_task_context file="…">…</history_task_context> }
│        ↑ 历史 MMD（mermaid 流程图），作为删除补偿插入在消息中部
│
├─ 当前用户消息（本轮输入）
│   ├─ prepend 模式（默认）: <relevant-memories>…</relevant-memories> + 用户原文
│   └─ append 模式:          用户原文 + <relevant-memories>…</relevant-memories>
│
└─ { role: "user", <current_task_context>…mermaid…</current_task_context> }
     ↑ 活跃任务 MMD，插入在最新用户消息之后（不拆散 tool_use/tool_result 对）
```

注入时机（hook 调用顺序）：

```mermaid
sequenceDiagram
    participant OC as OpenClaw 宿主
    participant P as 本插件
    participant LLM

    OC->>P: before_prompt_build (event.messages)
    Note over P: 长期记忆召回 performAutoRecall<br/>（5s 超时保护）
    P-->>OC: { appendSystemContext, prependContext }
    Note over OC: 宿主把 stable 部分拼进 system prompt，<br/>dynamic 部分拼到当前用户消息前/后

    Note over P: offload before_prompt_build 三阶段：<br/>① 重新应用已确认的 offload 替换/删除<br/>② token 守卫（mild/aggressive/emergency）<br/>③ 注入 MMD 消息到 messages

    OC->>LLM: system prompt + 修改后的 messages
    OC->>P: before_message_write（落盘前）
    Note over P: 从用户消息中剥离 &lt;relevant-memories&gt;，<br/>不污染 session JSONL transcript
```

## 长期记忆注入的内容格式

构造函数：`performAutoRecallInner()`（`src/core/hooks/auto-recall.ts:80-219`），在 `auto-recall.ts:164-196` 处把召回结果拆成**稳定部分**与**动态部分**：

- 稳定部分 → `appendSystemContext`：内容跨轮不变，留在 system prompt 里避免 prompt cache 失效
- 动态部分 → `prependContext`（默认）或 `appendContext`：L1 召回记忆每轮不同，贴着当前用户消息放

位置适配逻辑在 `src/adapters/openclaw/recall-injection.ts:17-43`；模式配置项 `recall.injectionMode`（`src/config.ts:92`，默认 `prepend`，见 `src/config.ts:648-652`）。

### stableContext（system prompt 追加，`\n\n` 连接）

```xml
<user-persona>
{persona.md 内容，已剥离 scene navigation 段落}
</user-persona>

<scene-navigation>
---
## 🗺️ Scene Navigation (Scene Index)
*以下是当前场景记忆的索引，可根据需要 read_file 读取详细内容。*

### Path: /abs/path/scene_blocks/xxx.md
**热度**: 120 🔥🔥 | **更新**: 2026-07-01
Summary: 场景的核心要点摘要
...
</scene-navigation>

<memory-tools-guide>
## 记忆工具调用指南
... tdai_memory_search / tdai_conversation_search / read_file 使用说明 ...
</memory-tools-guide>
```

注意 L2 场景块采用 progressive disclosure：上下文中只有索引（路径 + 热度 + 摘要），全文由 agent 按需 `read_file` 读取；L0 原始对话不直接注入，靠 `tdai_conversation_search` 工具检索。

### dynamicContext（当前用户消息旁）

```xml
<relevant-memories>
以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：

- [persona] 用户叫王小明，30岁，是一名软件工程师。
- [episodic|旅行计划] 用户计划五月去日本旅行。(活动时间: 2025-05-01 ~ 2025-05-10)
- [instruction] 用户要求回答时使用中文，保持简洁。
</relevant-memories>
```

单条格式由 `formatMemoryLine()` 生成（`auto-recall.ts:656-684`）：`- [type|scene_name] content (活动时间: …)`。数量与质量由 `maxResults=5`、`scoreThreshold=0.3` 控制；体积由 `applyRecallBudget()`（`auto-recall.ts:686-750`）按 `recall.maxCharsPerMemory` / `recall.maxTotalRecallChars` 截断（默认 0 = 不限制），截断后缀为 `…（已截断；可用 tdai_memory_search 或 tdai_conversation_search 查看详情）`。

### 持久化剥离

`<relevant-memories>` 只对当轮 LLM 可见。`before_message_write` hook（`index.ts:634-665`）在消息写入 session JSONL 前用正则把它剥掉，保证历史 transcript 干净、不会在下轮被重复注入。

## 短期记忆（context-offload）对 messages 的修改

offload 的 `before_prompt_build` 处理（`src/offload/hooks/before-prompt-build.ts:43`）分三阶段，直接改动 `event.messages`：

1. **Fast-path**：重新应用之前已确认的 offload 替换/删除（宿主可能重放原始历史）。
2. **Token 守卫**：按剩余预算触发 mild / aggressive / emergency 三档压缩。
3. **MMD 注入**：把任务流程图消息插进 messages。

具体改动形式：

- **offload 摘要替换**（`src/offload/l3-helpers.ts:224-229`）：原始 tool_result 被替换为三行摘要，全文留在磁盘文件里：

  ```
  [Offloaded Tool Result | node: 7]
  Summary: …
  result_ref: offload.{sessionId}.jsonl#L… (read this file for full tool call and raw result)
  ```

- **活跃 MMD**（`src/offload/mmd-injector.ts:33-122`）：以 `role: "user"` 消息插入，位置在**最新一条用户消息之后**、不拆散 tool_use/tool_result 对（`findActiveMmdInsertionPoint`，`mmd-injector.ts:200-234`）：

  ````xml
  <current_task_context>
  【当前活跃任务的mermaid流程图】这是你最近正在执行的任务的阶段性记录...
  **任务目标:** {taskGoal}
  **任务文件:** {mmdFile}
  **节点索引:** 可通过 node_id 在 offload.{sessionId}.jsonl 中查找...
  ```mermaid
  {mmdContent}
  ```
  标记为 "doing" 的节点是近期焦点...
  </current_task_context>
  ````

- **历史 MMD**（`src/offload/hooks/llm-input-l3.ts:1181` `buildHistoryMmdInjection()`）：aggressive 删除消息后的补偿，插入在活跃 MMD **之前**，格式为 `<history_task_context file="…">…</history_task_context>`，超预算（`contextWindow × mmdMaxTokenRatio`）时退化为 `mode="meta-only"` 的精简版。

- **L4 skill**（`src/offload/index.ts:831`）：生成 `<l4_skill_result>…</l4_skill_result>`，通过 `systemPromptAddition` 追加到 system prompt。

MMD 消息带 `_mmdContextMessage` / `_mmdInjection` 标记，L3 压缩会跳过它们，避免把流程图本身当成可压缩内容。

## 记忆分层与上下文的对应关系

**长期记忆**（README 语义金字塔）：

| 层 | 内容 | 在上下文中的位置 |
|---|---|---|
| L0 | 原始对话 JSONL | 不注入，`tdai_conversation_search` 按需检索 |
| L1 | 原子记忆（向量/FTS） | `<relevant-memories>`，当前用户消息前/后 |
| L2 | 场景块 `scene_blocks/*.md` | `<scene-navigation>` 索引，system prompt |
| L3 | 用户画像 `persona.md` | `<user-persona>`，system prompt |

**短期记忆（offload）流水线**：L1 flush → L1.5 任务判断 → L2 生成 Mermaid MMD → L3 上下文压缩（mild/aggressive/emergency）→ L4 skill 沉淀。

## 其他路径

- **Gateway / Hermes**：`POST /recall`（`src/gateway/server.ts:264`）返回 JSON `{ context, stable_context, dynamic_context, injection_mode, … }`（`src/adapters/gateway/recall-response.ts:12-30`），由 Hermes 端 Python 插件在 `prefetch()` 中消费；Hermes 只支持 append，prepend 请求会降级。
- **CLI 模式**：offload 还通过 Context Engine 的 `assemble()`（`src/offload/index.ts:2140`）生效，返回 `{ messages, estimatedTokens, systemPromptAddition }`，与 hook 路径功能等价。
