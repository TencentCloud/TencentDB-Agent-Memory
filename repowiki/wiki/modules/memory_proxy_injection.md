---
type: Module
title: Memory Proxy Injection
description: "> 子系统：MemoryProxy（`MemoryProxy/src/injection`）"
resource: repo://Team-Agent-Memory
tags: [Team-Agent-Memory, memory_proxy_injection]
generated_from: 0aff21a
generated: { by: codewiki/5.2.1, at: 2026-08-04T08:34:04Z }
stale_after: 2026-11-02
aliases: ["memory_proxy_injection"]
---
# MemoryProxy Injection 模块

> 子系统：MemoryProxy（`MemoryProxy/src/injection`）
> 职责：依赖注入管线（storage / redis 激活、会话状态恢复）。

## 1. 模块定位

Injection 是 MemoryProxy 的**引导管线**：在请求到达前激活存储后端（COS/SQLite）、Redis，并恢复会话绑定仓库（bindingRepo）。

## 2. 架构（Mermaid）

```mermaid
graph TD
  Req[请求到达] --> TryStorage[tryActivateStorage]
  TryStorage -->|失败| TryRedis[tryActivateRedis]
  TryStorage --> Binding[bindingRepo 绑定]
  TryRedis --> Binding
  Binding --> Next[业务路由]
```

## 3. 关键导出（server.ts 已引用）

- `tryActivateStorage(config)`：激活存储（COS 优先，降级 SQLite/fs）。
- `tryActivateRedis(config)`：激活 Redis。

## 4. 依赖

- 被 `[memory_proxy_handlers.md](memory_proxy_handlers.md)` 调用
