# TencentDB Agent Memory — Dify Plugin

把 TencentDB-Agent-Memory 接入 Dify 工作流，让 Dify Agent 能够跨会话记住用户偏好和历史。

## 工作原理

Dify plugin 通过 standalone Gateway HTTP sidecar 跟记忆引擎通信：

```
Dify Agent  ──→  Provider (本 plugin)  ──→  HTTP /search/*  ──→  Gateway  ──→  TdaiCore
              ←──  tool_result  ←──  JSON response  ←──  POST  ←──
```

跟 Hermes provider 共用同一个 Gateway——部署一次，两边都能调。

## 安装

### 1. 启动 Gateway

```bash
# 安装 Node >= 22
npm install -g @tencentdb-agent-memory/memory-tencentdb

# 启动 Gateway
TDAI_LLM_API_KEY=sk-... \
TDAI_LLM_MODEL=gpt-4o \
TDAI_DATA_DIR=~/.memory-tencentdb/memory-tdai \
npx tsx node_modules/@tencentdb-agent-memory/memory-tencentdb/src/gateway/server.ts
```

### 2. 安装 Dify Plugin

```bash
# Dify plugin 目录拷贝到 Dify 的 plugins 目录
cp -r dify-plugin/memory_tencentdb ~/dify/plugins/memory_tencentdb

# 或通过 Dify 管理界面 → 插件 → 本地安装，选择本目录
```

### 3. 配置

Dify 管理界面 → 插件 → memory_tencentdb → 配置：

| 参数           | 说明                          | 默认值         |
| -------------- | ----------------------------- | -------------- |
| gateway_host   | Gateway 主机名                | `127.0.0.1`   |
| gateway_port   | Gateway 端口                  | `8420`         |
| api_key        | Bearer token（跟 Gateway 一致）| 无             |

## 工具

### `memory_tencentdb_memory_search`

搜 L1 结构化记忆。

参数：`query` (必填)、`limit` (可选，默认 5)、`type` (可选 persona/episodic/instruction)、`scene` (可选)

### `memory_tencentdb_conversation_search`

搜 L0 原始对话。

参数：`query` (必填)、`limit` (可选)、`session_key` (可选)

## 与 Hermes Provider 的差异

| 维度         | Hermes Provider                       | Dify Plugin                      |
| ------------ | ------------------------------------- | -------------------------------- |
| 语言         | Python                                | Python                           |
| 传输         | HTTP → standalone Gateway             | 同 Hermes                        |
| 工具数量     | 2 个搜索 + prefetch/sync_turn 内部    | 2 个搜索（工具注册对 LLM 可见）   |
| 熔断器       | 有（5 次失败开断、60s 冷却）          | 无（依赖 Dify 自身超时）          |
| 看门狗       | 有（daemon 线程定期探活）             | 无（Gateway 需外部守护）          |
| Gateway 拉起 | supervisor 自动起进程                 | 手动启 Gateway                   |
| 错误降级     | 熔断器短路返回空                      | 异常返回 error JSON               |
| 线程模型     | daemon 线程池 + 信号量限流            | Dify 框架管理（同步调用）          |

## 故障排查

### Gateway 连不上

检查 Gateway 是否在跑：

```bash
curl http://127.0.0.1:8420/health
# {"status":"ok","version":"0.1.0","uptime":123,"stores":{"vectorStore":true,"embeddingService":false}}
```

### 搜索结果总是空

确认 LLM API key 已配置（`TDAI_LLM_API_KEY`），embedding 服务需 LLM 提取记忆后再搜。首次 use 后等一轮 capture + L1 提取。

### 跨平台数据不互通

确认 Gateway 的 `TDAI_DATA_DIR` 跟其他适配器（OpenClaw / MCP server）指向同一目录。
