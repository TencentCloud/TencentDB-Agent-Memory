---
type: Module
title: Memory Panel Web
description: "> 子系统：MemoryPanel（`MemoryPanel/web/src`）"
resource: repo://Team-Agent-Memory
tags: [Team-Agent-Memory, memory_panel_web]
generated_from: 0aff21a
generated: { by: codewiki/5.2.1, at: 2026-08-04T08:34:19Z }
stale_after: 2026-11-02
aliases: ["memory_panel_web"]
---
# MemoryPanel Web 模块

> 子系统：MemoryPanel（`MemoryPanel/web/src`）
> 职责：记忆/知识的可视化管理面板前端（React + TypeScript）。

## 1. 模块定位

MemoryPanel 是面向用户的**可视化控制台**，展示记忆、知识、会话与团队隔离视图，并提供管理操作。

## 2. 技术栈（Mermaid）

```mermaid
graph LR
  UI[React 组件] --> State[状态管理]
  State --> Api[API 客户端]
  Api --> Proxy[MemoryProxy]
  Api --> Core[MemoryCore]
  Api --> Knowledge[MemoryKnowledge]
```

## 3. 职责

- 记忆检索与回溯可视化
- 知识库（MemoryKnowledge）浏览
- 团队/agent 隔离字段管理
- 审计与 profile 查看

## 4. 依赖

- 后端：`[memory_proxy_handlers.md](memory_proxy_handlers.md)`、`[memory_core_gateway.md](memory_core_gateway.md)`、`[memory_knowledge_src.md](memory_knowledge_src.md)`
