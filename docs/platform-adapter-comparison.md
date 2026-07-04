# Platform Adapter Comparison

## 概述

本文档对比 TencentDB-Agent-Memory 的所有平台适配方案，分析架构模式、集成面和设计取舍。

## 适配器矩阵

| 维度 | OpenClaw (已有) | Hermes v1 (已有) | **Claude Code (本项目)** | **CodeBuddy (本项目)** | PR #339 Bridge | PR #359 6-Platform |
|:---|---|---|---|---|---|---|
| **语言** | TypeScript | Python | **TypeScript** | **TypeScript** | Python | TypeScript |
| **接入方式** | 进程内 API | HTTP Gateway | **MCP stdio** | **MCP stdio** | HTTP + MCP | HTTP + MCP |
| **基类/接口** | HostAdapter | MemoryProvider | **HostAdapter** | **HostAdapter** | TdaiAdapter ABC | MemoryPlatformAdapter |
| **工具数** | 2 | 2 | **4** | **4** | 5 | varies |
| **自动 recall** | ✅ hook | ✅ prefetch | **✅ MCP tool** | **✅ MCP tool** | ✅ | ✅ |
| **自动 capture** | ✅ hook | ✅ sync_turn | **✅ MCP tool** | **✅ MCP tool** | ✅ | ✅ |
| **Session 管理** | ✅ 内置 | ✅ 内置 | **manual** | **manual** | ✅ | varies |
| **熔断器** | N/A | 5/60s | **Gateway 自带** | **Gateway 自带** | 5/60s | 3-state |
| **限流** | N/A | N/A | **Gateway 自带** | **Gateway 自带** | 60/60s | N/A |
| **重试** | 平台原生 | 平台原生 | **Gateway 自带** | **Gateway 自带** | 指数退避 | 指数退避 |
| **适配器行数** | ~117 | ~1130 | **~85** | **~85** | ~528 (ABC) | varies |
| **测试** | 集成测试 | 78 tests | **待添加** | **待添加** | 135+ tests | 353 tests |
| **设计理念** | 薄壳模式 | Provider 模式 | **薄壳模式** | **薄壳模式** | 抽象 SDK 模式 | 广度模式 |

## 数据流对比

### OpenClaw（已有）
```
Agent → OpenClaw PluginApi → OpenClawHostAdapter → TdaiCore (进程内)
                                                        ↓
                                                   SQLite (本地)
```

### Hermes（已有）
```
Agent → Hermes Agent → MemoryTencentdbProvider → Gateway (HTTP)
                                                     ↓
                                                TdaiCore → SQLite
```

### Claude Code（本项目）
```
Agent → MCP stdio → cc-mcp-server.ts → Gateway (HTTP)
                                           ↓
                                      TdaiCore → SQLite
```

### CodeBuddy（本项目）
```
Agent → MCP stdio → （复用 cc-mcp-server.ts）→ Gateway (HTTP)
                                                  ↓
                                             TdaiCore → SQLite
```

## 设计决策

### 为什么复用 HostAdapter 而非新建抽象层？

1. **已被生产验证**: OpenClawHostAdapter (117行) 和 StandaloneHostAdapter (97行) 已在生产环境运行
2. **极简主义**: 每个新平台只需 ~85行 TypeScript 即可接入
3. **零新增抽象**: 不引入 TdaiAdapter ABC、TdaiClient、TdaiRegistry 等非必要层次
4. **TdaiCore 是真正的"统一引擎"**: 所有平台共用同一个 `TdaiCore`，无需包装

### 为什么 CC 使用 MCP 而非 hooks？

1. **MCP 是 CC 的一等公民**: Claude Code 原生支持 MCP 协议
2. **跨平台复用**: 同一个 MCP server 可被 CC、CodeBuddy、Cursor 等共用
3. **hooks 作为补充**: CC hooks (shell commands) 处理自动 recall/capture，MCP tools 处理按需搜索

### 与 PR #339 的关系：互补而非竞争

PR #339 与本项目都服务于 Issue #235「让 TDAI 记忆可从任何平台访问」的目标，但切入点不同，二者互补而非替代。感谢 @gugu23456789 在 PR #385 评论区对 PR #339 设计意图的澄清，以下据此修订对比，避免误读为竞争关系。

| 维度 | PR #339（纵向 · 跨语言桥） | 本项目（横向 · IDE 适配） |
|:---|:---|:---|
| **目标** | 跨语言：打通 Python 生态 + 提供独立 MCP fallback | 跨 IDE：Claude Code / CodeBuddy 等原生接入 |
| **为何需要新抽象** | Python 没有 HostAdapter / Hermes Provider，需 `TdaiAdapter` ABC 对齐多语言契约 | TS 侧已有 HostAdapter，直接扩展即可，无需新抽象 |
| **SDK** | Python `bridge_adapter` + TS `TdaiAdapter`（双语言对齐） | 复用已有 TS HostAdapter，不重复造轮子 |
| **MCP server** | 独立 stdio server，带 G0-G5 自 gating（格式检查 / HMAC 鉴权 / 限流 / 熔断 / 审计），可脱离 Hermes 作安全网 | cc-mcp-server.ts 薄客户端，鉴权 / 限流 / 熔断交由 Gateway |
| **新增平台** | 侧重 SDK 与 bridge 基建 | CC + CodeBuddy，并复用 Hermes |
| **E2E 验证** | — | Hermes 写入 → CC 召回 → CodeBuddy 召回 |
| **角色定位** | 纵向：Python + TS + MCP 跨语言桥 | 横向：扩展更多 IDE 平台 |

> 两者可并存：PR #339 的独立 MCP server（带自 gating 的安全网）与本项目复用 Gateway 侧能力的薄 MCP 客户端各司其职；本项目在 TS 侧的「薄壳」适配与 PR #339 在跨语言侧的「桥接」抽象并不冲突。

### 核心理念

**"Don't wrap the engine — extend it."**

本项目在 TypeScript 侧用新的 HostAdapter 实现扩展 TdaiCore——这是 `src/adapters/` 目录的设计意图，也是 OpenClawHostAdapter / StandaloneHostAdapter 已验证的模式。需要说明的是，这并不排斥跨语言场景下的桥接抽象：Python 等没有 HostAdapter 的语言，确实需要类似 PR #339 `TdaiAdapter` ABC 的契约层来对齐多语言 SDK。「不包装引擎」是 TS 侧的取舍，而非对其它语言方案的否定。
