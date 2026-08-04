# 【云脑方案文档】阶段 1：Cursor 接入 feat/server_team

> 范围：复用现有 Cursor Adapter，只实现接入目标分支的差异。

# 需求分析

复用当前 Cursor Adapter，接入 `feat/server_team` 的 MemoryCore v3。范围包括 L0 回流、L1/L0 检索和 L2/L3 轻量注入；不包含 Codex CLI。

## 功能需求

1. 保留现有 Cursor Hook、transcript、pending、worker、MCP 和安装行为。
2. 使用 `feat/server_team` 的 TypeScript v3 SDK，替换旧 `/capture` 与 `/search/*`。
3. 每次调用必须携带 service/team/agent/user；task 可选，session 从 Cursor 会话派生。
4. Cursor 前台 Hook 继续保持无网络、fail-open。
5. MemoryCore 不可用时保留完整 pending，恢复后由后续 `stop` 或 `sessionEnd` 推进。

## 非功能需求

- 不降低现有 Cursor 前台响应与数据安全边界。
- 不在日志中保存完整 prompt、response、API key 或隔离凭据。
- 安装和卸载只修改 Adapter 自己拥有的配置。
- 阶段 1 不为 Codex CLI 建设公共框架。

## 现状分析

### 当前 Cursor 基线

当前 `src/adapters/cursor/` 已实现完整客户端链路：

```text
sessionStart → marker/context
stop → transcript → pending → detached worker → /capture
MCP → /search/memories | /search/conversations
```

因此，本阶段只处理旧 Gateway 契约到 v3 契约的适配。

### feat/server_team

目标分支已提供 MemoryCore v3 SDK 和 L0–L3 HTTP API。新接入必须使用 service/team/agent/user 严格隔离；L0 写入还需要 session。

`MemoryCore/openclaw-plugin/` 已证明 Agent Adapter 可直接使用 v3 SDK。当前分支没有 Cursor Adapter，也没有可直接复用的 Cursor Hook 安装与 transcript 处理。

## 收益及风险

### 收益

- 最大化复用已验证的 Cursor 代码。
- 不修改 MemoryCore 和 MemoryProxy，降低服务端回归范围。
- Cursor 数据进入 Team/Agent/User 隔离的 v3 存储。
- 阶段 1 可独立测试、发布和回滚。

### 风险

| 风险 | 处理 |
|---|---|
| server_team 可远端部署，旧本地文件注入失效 | worker 维护最终一致的 L2/L3 本地只读快照 |
| isolation 配错导致写入错误空间 | 启动校验必填字段，E2E 核对服务端维度 |
| 服务端不可用 | 前台 fail-open，pending 保留 |
| 缓存过期 | 注入标明快照时间；MCP 使用实时查询 |
| 现有 Cursor 门禁未闭环 | 延续原状态，不包装为本阶段成果 |

# 业务流程

## 核心业务流程图

```mermaid
flowchart LR
  A[Cursor sessionStart] --> B[读取 L2/L3 缓存]
  B --> C[注入上下文和 MCP 指引]
  D[Cursor stop] --> E[读取最后完整 transcript 轮次]
  E --> F[pending JSONL]
  F --> G[detached worker]
  G --> H[v3 conversation/add]
  H --> I[刷新当时可见的 L2/L3 快照]
  J[MCP 检索] --> K[v3 atomic/conversation search]
```

## 降级容错方案

- 缓存不存在：只注入 MCP 指引。
- L0 写入失败：保留 pending，等待下次唤醒。
- MCP 查询失败：返回 bounded 可读错误，不阻断 Cursor。
- MemoryCore 进程由部署系统管理，Adapter 不尝试拉起。

# 概要设计

## 总体架构

生产代码迁入：

```text
MemoryCore/src/adapters/cursor/
```

复用现有模块边界，只替换数据面和配置：

| 模块 | 输入 | 输出 | 处理 |
|---|---|---|---|
| Hooks | Cursor 生命周期 payload | context、pending、worker 唤醒 | 复用 |
| transcript/pending | Cursor transcript | 一轮可重试记录 | 复用 |
| worker | pending、v3 配置 | L0 ACK、缓存刷新 | 修改调用端 |
| MCP | 查询参数 | L1/L0 结果 | 修改调用端 |
| installer | Cursor 配置 | Hooks/MCP/Rule | 复用 |

### 只改差异

| 删除或替换 | 新行为 |
|---|---|
| `/capture` | v3 `MemoryClient.addConversation()` |
| `/search/memories` | v3 `searchAtomic()` |
| `/search/conversations` | v3 `searchConversation()` |
| 直接读取 Gateway 数据目录 | 读取 Adapter 的 L2/L3 快照 |
| `memory-tencentdb-ctl.sh start` | 删除；服务端独立管理 |
| `/session/end` | 删除；v3 无对应消费者 |

## 数据结构

| 键或字段 | TTL | 用途 |
|---|---:|---|
| `sessions/<hash>` | 会话结束清理 | 顶层会话 marker |
| `pending/<hash>.jsonl` | 不完整记录 24 小时 | L0 可重试投递 |
| `cache/context.json` | 无硬 TTL | 最近成功的 L2/L3 快照 |
| service/team/agent/user | 配置长期有效 | v3 严格隔离 |
| task | 可选 | 当前任务关联 |
| `cursor:<conversation_id>` | 会话期 | v3 session |

缓存带 isolation 指纹和刷新时间；指纹与当前配置不一致时不得注入。MemoryCore 在 L0 ACK 后异步推进 L1/L2/L3，因此该缓存允许落后，不作为本轮抽取完成证据。

## 交互接口

| 状态 | 接口 | 用途 | 出处 |
|---|---|---|---|
| 已落地 | `/v3/conversation/add` | 回流本轮 L0 | `feat/server_team:sdk/memory-core/typescript/src/v3/client.ts#addConversation` |
| 已落地 | `/v3/atomic/search` | L1 主动检索 | 同文件 `searchAtomic` |
| 已落地 | `/v3/conversation/search` | L0 证据检索 | 同文件 `searchConversation` |
| 已落地 | `/v3/scenario/ls` | 刷新 L2 导航 | 同文件 `listScenarios` |
| 已落地 | `/v3/core/read` | 刷新 L3 | 同文件 `readCore` |
| 设计新增 | `cache/context.json` | 前台无网络注入 | `docs/cursor-server-team/spec.md` |

# 验收标准

1. 现有 Cursor Adapter 测试迁移后全部通过。
2. 迁移后的 Cursor Adapter 不再引用旧 `/capture`、`/search/*`、ctl 或 `/session/end`；MemoryCore 兼容接口不在删除范围。
3. v3 写入和查询均携带正确 isolation。
4. 前台 Hook 不访问网络，也不管理 MemoryCore 进程。
5. 成功 ACK 后删除 pending；可重试和未知错误保留。
6. 缓存刷新失败保留旧快照，不影响 L0 ACK；缓存不承诺立即包含本轮异步抽取结果。
7. 真实 Cursor E2E 完成“本轮写入、新会话实时检索、隔离核对”；L2/L3 快照只验证可用性和隔离，不验证本轮即时更新。
8. 阶段 1 的代码、测试和文档不包含 Codex CLI 实现。

## 阶段 2 边界

Codex CLI 独立记录于 `docs/codex-cli-server-team/`。阶段 1 不为其预建代码、抽象、配置或测试；阶段 1 验收也不依赖阶段 2。
