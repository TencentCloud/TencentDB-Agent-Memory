---
type: Module
title: Sdk
description: "> 子系统根：sdk/（含 memory-core/typescript、memory-core/python）"
resource: repo://Team-Agent-Memory
tags: [Team-Agent-Memory, sdk]
generated_from: 0aff21a
generated: { by: codewiki/5.2.1, at: 2026-08-04T08:38:02Z }
stale_after: 2026-11-02
aliases: ["sdk"]
---
# SDK 模块

> 子系统根：sdk/（含 memory-core/typescript、memory-core/python）
> 职责：多语言客户端 SDK，类型安全调用 MemoryCore。

## 1. 子系统定位

SDK 是平台的开发者入口，提供与 Gateway v2 契约对齐的客户端与类型，覆盖 TS/Node 与 Python 生态。

## 2. 子模块索引

- sdk_typescript.md：TypeScript SDK（类型 + API）
- sdk_python.md：Python SDK

## 3. 关键设计

- 类型与 Gateway types.ts（[IdFields](../../../MemoryCore/src/core/skill/types.ts)、[ApiResponseEnvelope](../../../MemoryCore/src/gateway/v2-schemas.ts)）严格对齐。
