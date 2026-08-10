---
type: Module
title: Sdk Typescript
description: "> 子系统：sdk（`sdk/memory-core/typescript`）"
resource: repo://Team-Agent-Memory
tags: [Team-Agent-Memory, sdk_typescript]
generated_from: 0aff21a
generated: { by: codewiki/5.2.1, at: 2026-08-04T08:34:31Z }
stale_after: 2026-11-02
aliases: ["sdk_typescript"]
---
# SDK TypeScript 模块

> 子系统：sdk（`sdk/memory-core/typescript`）
> 职责：TypeScript 客户端 SDK，暴露类型与记忆核心 API。

## 1. 模块定位

TypeScript SDK 让前端/Node 应用以类型安全的方式调用 MemoryCore。已读取 `src/types.ts`：定义 v2 请求/响应类型与 [IdFields](../../../MemoryCore/src/core/skill/types.ts) 隔离字段。

## 2. 类型（Mermaid）

```mermaid
graph TD
  Env[ApiResponseEnvelope] --> Data[data: T]
  IdFields[team_id/agent_id/user_id/task_id] --> Req[ConversationAddRequest]
  IdFields --> Offload[OffloadRequest]
```

## 3. 关键类型

- `ApiResponseEnvelope<T>`：统一响应包（code/message/request_id/data）。
- `IdFields`：四 ID 隔离字段（可选）。
- `ConversationItem` / `ConversationAddRequest`：会话记忆类型。

## 4. 依赖

- 对齐 `[memory_core_gateway.md](memory_core_gateway.md)` 的 v2 契约
