---
type: Module
title: Memory Core Offload Server
description: "> 子系统：MemoryCore（`MemoryCore/src/offload_server`）"
resource: repo://Team-Agent-Memory
tags: [Team-Agent-Memory, memory_core_offload_server]
generated_from: 0aff21a
generated: { by: codewiki/5.2.1, at: 2026-08-04T08:31:58Z }
stale_after: 2026-11-02
aliases: ["memory_core_offload_server"]
---
# MemoryCore Offload Server 模块

> 子系统：MemoryCore（`MemoryCore/src/offload_server`）
> 职责：offload 服务的独立部署形态（server 化封装）。

## 2. 部署形态

```mermaid
graph LR
  Gateway[Gateway] --> Offload[Offload 服务]
  OffloadServer[OffloadServer 独立进程] --> Offload
  OffloadServer --> Core[Core 存储]
```


## 2. 依赖

- 复用于 `[memory_core_offload.md](memory_core_offload.md)` 的服务逻辑
- 复用 `[memory_core_core.md](memory_core_core.md)` 的存储/配置
