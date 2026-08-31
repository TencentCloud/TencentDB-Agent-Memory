# Session Init 初始化链路分析报告

> 以「Claude Code 客户端发送一条消息」为起点，梳理 Proxy 中 Session Init 的完整触发链路。
> 核心代码：`MemoryProxy/src/session/claude-code/init.ts`（约 1115 行）

---

## 1. 一句话概括

Session Init 是一个**状态机**：在用户首次对话时，通过表单引导选择 **Team → Agent → Task** 三要素，注册后把这三要素的上下文**注入到后续每一轮请求**中，让模型始终知道自己"在哪个团队、扮演哪个角色、做哪个任务"。

---

## 2. 触发链路全景图

```
Claude Code 客户端
    │  POST /claude-code/<spaceId>/v1/messages
    ▼
┌─────────────────────────────────────────────┐
│ server.ts 路由匹配 /:agent/:spaceId/v1/messages │
└──────────────────┬──────────────────────────┘
                   ▼
┌─────────────────────────────────────────────┐
│ anthropicHandler.ts 主流程                     │
│  1. 验证 API Key（early auth）                 │
│  2. 解析请求体                                  │
│  3. 请求分类：main / fork / sidequery          │
│  4. 模型校验 + 别名重写                          │
│  5. 解析会话标识（conversationId）              │
└──────────────────┬──────────────────────────┘
                   ▼
┌─────────────────────────────────────────────┐
│ ★ Session Init（本文重点）                     │
│ 触发条件：                                      │
│   sessionInit.enabled                         │
│   && conversationId 存在                      │
│   && 请求类型 ≠ sidequery                      │
└──────────────────┬──────────────────────────┘
                   ▼
        ┌──────────┴──────────┐
        │                     │
   intercepted=true      intercepted=false
   （表单未选完）          （已注册 / bypass）
        │                     │
        ▼                     ▼
  直接返回表单响应      合并 systemAppend 到 body.system
  （不转发上游，         → 继续走注入管线 → 转发上游
   零 token 消耗）
```

---

## 3. 状态机详解

### 3.1 状态流转

```
uninitialized（首次进入）
    │  弹表单："是否关联资产？"
    ▼
pending_asset_confirm
    │  用户答 Yes/No
    ▼
pending_team_select ──── 仅当 team ≥ 2 时弹表单；只有 1 个则自动选中
    │  用户选定 team
    ▼
pending_agent_select ── 仅当 agent ≥ 2 时弹表单；只有 1 个则自动选中
    │  用户选定 agent
    ▼
pending_task_select ─── 仅当 task ≥ 2 时弹表单；只有 1 个则自动选中
    │  用户选定 task
    ▼
initialized（终态）──── 每轮自动 strip 旧块 + inject 新块
```

### 3.2 各状态的含义

| 状态 | 含义 | Proxy 动作 |
|------|------|-----------|
| `uninitialized` | 全新会话，尚未开始 | 拉取 teams 列表，弹出第一张表单 |
| `pending_asset_confirm` | 询问是否关联资产 | 等待用户 Yes/No |
| `pending_team_select` | 等待选团队 | 解析选择 → 级联拉取 agents |
| `pending_agent_select` | 等待选角色 | 解析选择（支持翻页）→ 拉取 tasks |
| `pending_task_select` | 等待选任务 | 解析选择 → 拉详情 → 注册 → 注入 |
| `initialized` | 注册完成 | 每轮 strip + inject，不再弹表单 |

### 3.3 表单交互的本质

表单是用 **`AskUserQuestion` 工具**伪装的：Proxy 拦截请求后，**不转发上游**，而是直接构造一个 SSE 流式响应返回给客户端——内容是模型"调用 AskUserQuestion 工具"的假消息。用户在界面上点选后，下一轮请求的 tool_result 里就带上了选择结果，Proxy 解析它推进状态机。

**关键收益：整个选择过程零 token 消耗**（请求从未到达上游模型）。

---

## 4. 核心函数一览

| 函数 | 位置 | 职责 |
|------|------|------|
| `handleSessionInit` | init.ts L569 | 顶层入口，包装埋点 |
| `handleSessionInitInner` | init.ts L599 | 状态机主体，按 status 分发 |
| `fetchTeamsAndAgents` | init.ts L110 | 从内核拉取 teams/agents/tasks 并缓存 |
| `advanceFromTeamPicked` | init.ts L204 | 选定 team 后的级联逻辑 |
| `advanceFromAgentPicked` | init.ts L275 | 选定 agent 后的级联逻辑 |
| `completeRegistration` | init.ts L420 | 最终注册：拉详情 → 构建 sessionInfo → 存储 → 注入 |
| `applyArtifactsAndContext` | init.ts L383 | 按协议注入上下文（Anthropic/OpenAI 分叉） |
| `isFreshCCConversation` | init.ts L87 | 判断是否新对话（≤5 条 user 消息且无 tool 消息） |
| `autoSelectSoloAgent` | init.ts L178 | 兜底：末页只剩 1 个 agent 时自动选中 |

---

## 5. 关键设计决策

### 5.1 Auto-select 级联：能跳的表单都跳

当某一级只有 1 个选项时自动选中、不弹表单。最小配置（1 team + 1 agent + 1 task）下，用户只需回答一个"是否关联资产"，后续全自动完成。

### 5.2 三要素齐全才注入

必须 **team + agent + task 三者全部拿到**才注册和注入，任何缺失 → `bypassed`。这避免了"注册成功但 task_id 为 undefined"的半成品状态污染下游。

### 5.3 协议分叉：systemAppend vs messages

Anthropic 和 OpenAI 的 system prompt 位置不同，注入方式也不同：

| 协议 | system 位置 | 注入方式 |
|------|------------|---------|
| Anthropic | `body.system`（独立字段） | init 返回 `systemAppend` 字符串，由 handler 合并到 `body.system` |
| OpenAI | 在 `messages` 数组内 | init 直接把上下文块插入 `messages` |

### 5.4 Preset Identity：Header 预设免表单

请求头可携带 `x-team-id` / `x-agent-id` / `x-task-id` 直接指定三要素，**完全跳过表单交互**直接注册（Hermes/OpenClaw 等无交互界面的客户端用这条路）。

### 5.5 L2b Recovery：状态丢失自动恢复

若 session 状态意外丢失但对话有历史（比如 Proxy 重启），会尝试从 binding 仓库反查恢复：

- 恢复到终态 → 直接 re-inject，无需重新弹表单
- 恢复到中间态 → 从该状态继续走状态机

### 5.6 每轮注入是幂等的（strip + inject）

`initialized` 之后每轮请求：先**剥离上一轮注入的旧 `<session_context>` 块**，再注入新块。这样上下文不会随对话轮数累积膨胀。

### 5.7 分页与 MORE

agent/task 列表超过 4 个时翻页展示，用户选 "MORE" 进入下一页，末页回绕到第 0 页。`autoSelectSoloAgent/Task` 防御末页只剩 1 项的场景。

### 5.8 defaultTaskId 虚拟条目

若配置了 `defaultTaskId`，tasks 列表头部插入"本次不关联任务"虚拟条目。选中它时 `getTask` 返回 404，由 `Promise.allSettled` 兜住 → `taskDetail = null` → 实现"关联 agent 但跳过 task"的语义，**表单和解析器零改动**。

---

## 6. 返回结果的三种走向

`handleSessionInit` 返回 `SessionInitResult`，handler 按字段分流：

| 结果 | 字段特征 | handler 动作 |
|------|---------|-------------|
| **拦截** | `intercepted: true` + `response` | 直接返回表单响应，**不转发上游** |
| **旁路** | `bypassed: true` | 跳过注入，正常转发 |
| **完成** | `sessionInfo` + `systemAppend` | 合并到 `body.system`，正常转发；若 `justRegistered` 还会同步 prewarm 注入缓存 |

---

## 7. 一次完整对话的时间线示例

```
第 1 轮  用户输入 "帮我写个报告"
         └─ Proxy: uninitialized → 弹"是否关联资产?"表单（拦截，0 token）

第 2 轮  用户点 "Yes"
         └─ Proxy: 弹"选择 Team"表单（拦截，0 token）

第 3 轮  用户选 "平台组"
         └─ Proxy: 该 team 下仅 1 个 agent → 自动选中，弹"选择 Task"表单

第 4 轮  用户选 "周报生成"
         └─ Proxy: completeRegistration → sessionInfo 落库
                   → systemAppend 注入 → 转发上游（开始消耗 token）
                   → 响应写回 L0 记忆

第 5+ 轮 每轮自动 strip 旧块 + inject 新块，模型始终带着
         "平台组 / 报告助手 / 周报生成" 的上下文工作
```

---

## 8. 小结

Session Init 本质上回答了三个问题：

1. **你是谁**（Team/Agent）—— 通过表单或 Header 确定
2. **你在做什么**（Task）—— 通过表单或 Header 确定
3. **模型怎么知道**（注入）—— 每轮 strip + inject，Anthropic 走 `body.system`，OpenAI 走 `messages`

它的价值在于：把"选择上下文"从人工配置（改环境变量/配置文件）变成**对话内交互**，且整个选择过程不消耗任何上游 token。
