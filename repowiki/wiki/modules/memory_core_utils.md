---
type: Module
title: Memory Core Utils
description: "> 子系统：MemoryCore（`MemoryCore/src/utils`）"
resource: repo://Team-Agent-Memory
tags: [Team-Agent-Memory, memory_core_utils]
generated_from: 0aff21a
generated: { by: codewiki/5.2.1, at: 2026-08-04T08:32:20Z }
stale_after: 2026-11-02
aliases: ["memory_core_utils"]
---
# MemoryCore Utils 模块

> 子系统：MemoryCore（`MemoryCore/src/utils`）
> 职责：通用工具函数（日志、序列化、ID 生成等）。

## 1. 模块定位

跨模块复用的基础设施工具。

## 2. 依赖关系

```mermaid
graph LR
  Gateway[Gateway] --> Utils[utils]
  Core[Core] --> Utils
  Offload[Offload] --> Utils
```


## 2. 依赖

- 被 MemoryCore 各模块引用
