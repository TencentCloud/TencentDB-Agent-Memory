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

### 与 PR #339 的对比

| 方面 | PR #339 | 本项目 |
|:---|:---|:---|
| 抽象层 | 新增 TdaiAdapter ABC（528行） | 复用已有 HostAdapter（0行新增） |
| SDK | Python + TypeScript 双语言 SDK | 不重复造轮子 |
| MCP server | bridge/mcp/server.py (431行) | cc-mcp-server.ts (~280行) |
| 实际平台代码 | 0 行（删掉了 CodexAdapter） | CC + CodeBuddy + Hermes |
| E2E 验证 | 无 | 待完成 |
| 总新增代码 | ~5800行 | ~800行 |

### 核心理念

**"Don't wrap the engine — extend it."**

不包装 TdaiCore，而是用新的 HostAdapter 实现来扩展它。这是项目作者的设计意图——`src/adapters/` 目录的存在就是为了这个目的。
