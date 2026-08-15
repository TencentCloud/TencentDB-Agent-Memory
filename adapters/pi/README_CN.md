# TencentDB Agent Memory 的 Pi 适配器

[English](./README.md)

这是一个面向 [Pi](https://pi.dev/) 的原生扩展，通过 TencentDB Agent
Memory 为 Pi 增加持久记忆。它直接使用 Pi 的生命周期事件与工具接口，不需要 MCP
桥接，也不需要监听 Pi 的会话文件。

## 功能

- 每次 Agent 运行前自动召回 L1 原子记忆。
- 可选注入有长度上限的 L2 场景摘要和 L3 核心画像。
- Pi 完全结束本轮工作后，把完整的用户/助手回合写入 L0。
- 提供 Pi 原生工具，供模型主动搜索原子记忆和历史对话。
- 每次调用都携带 v3 推荐的 Team、Agent、User 隔离字段。
- 请求超时或 MemoryCore 不可用时自动降级，不阻断 Pi 的主任务。
- 明确把召回内容标记为不可信数据，并限制注入长度。
- 把成功采集的哈希持久化为不进入模型上下文的 Pi 会话元数据，跨 reload
  去重重复事件。

## 架构

~~~text
Pi before_agent_start
        |
        +--> POST /v3/atomic/search ---- L1 相关记忆
        +--> POST /v3/scenario/ls ------ L2 摘要（可选）
        +--> POST /v3/core/read -------- L3 画像（可选）
        |
        +--> 有长度上限的 system prompt 上下文

Pi agent_end -> agent_settled
        |
        +--> POST /v3/conversation/add - L0 完整回合
~~~

适配器不会读取 Pi 会话文件，也不会直接操作 TencentDB 的记忆存储；MemoryCore
始终是唯一的存储与抽取边界。

## 环境要求

- Node.js 22.19 或更高版本
- Pi 0.84.1 或更高版本
- 可访问的 TencentDB Agent Memory v3 Gateway
- Service ID、Team ID、Agent ID、User ID 和 API Key

启动 MemoryCore 请参考仓库的[安装指南](../../INSTALL_CN.md)。

## 安装

在本仓库克隆目录中执行：

~~~bash
pi install ./adapters/pi
~~~

仅为当前项目安装：

~~~bash
pi install -l ./adapters/pi
~~~

不修改 Pi 设置、只做一次本地试跑：

~~~bash
pi -e ./adapters/pi/src/index.ts
~~~

Pi 会提供扩展运行时依赖。本适配器按照 Pi 包规范把它们声明为 peer
dependencies。

## 配置

启动 Pi 前设置以下必填环境变量：

~~~bash
export TDAI_MEMORY_ENDPOINT="http://127.0.0.1:8420"
export TDAI_MEMORY_API_KEY="your-api-key"
export TDAI_MEMORY_SERVICE_ID="your-memory-instance"
export TDAI_MEMORY_TEAM_ID="team-xxx"
export TDAI_MEMORY_AGENT_ID="agent-xxx"
export TDAI_MEMORY_USER_ID="user-xxx"

pi
~~~

### 环境变量

| 变量 | 必填 | 默认值 | 用途 |
| --- | --- | --- | --- |
| TDAI_MEMORY_ENDPOINT | 否 | http://127.0.0.1:8420 | MemoryCore Gateway 地址 |
| TDAI_MEMORY_API_KEY | 是 | — | Bearer 凭据；适配器不会把它写入磁盘 |
| TDAI_MEMORY_SERVICE_ID | 是 | — | 通过 x-tdai-service-id 传入的记忆实例 |
| TDAI_MEMORY_TEAM_ID | 是 | — | v3 Team 隔离 |
| TDAI_MEMORY_AGENT_ID | 是 | — | v3 Agent 隔离 |
| TDAI_MEMORY_USER_ID | 是 | — | v3 User 隔离 |
| TDAI_MEMORY_TASK_ID | 否 | — | 可选的 v3 Task 隔离 |
| TDAI_PI_TIMEOUT_MS | 否 | 5000 | 单次请求超时，范围 100–60000 ms |
| TDAI_PI_RECALL_LIMIT | 否 | 5 | L1 返回条数，范围 1–20 |
| TDAI_PI_SCENARIO_LIMIT | 否 | 3 | L2 摘要条数，范围 0–20 |
| TDAI_PI_MAX_CONTEXT_CHARS | 否 | 8000 | 每轮召回上下文最大字符数 |
| TDAI_PI_INCLUDE_CORE | 否 | true | 是否注入 L3 核心画像 |
| TDAI_PI_INCLUDE_SCENARIOS | 否 | true | 是否注入 L2 场景摘要 |
| TDAI_PI_ALLOW_INSECURE_HTTP | 否 | false | 是否允许通过非回环 HTTP 发送 Bearer 凭据 |

默认拒绝远程明文 HTTP，防止 Bearer 凭据泄露。如果使用明确可信的内网或 Docker
主机名，可以设置 TDAI_PI_ALLOW_INSECURE_HTTP=1；仍建议优先使用 HTTPS。

## 使用

自动召回和自动采集无需额外提示模型。扩展还会注册：

- tdai_memory_search：搜索持久化的 L1 原子记忆。
- tdai_conversation_search：搜索 L0 原始对话证据。
- /tdai-memory-status：检查带鉴权的 v3 连通性。

Pi 会话 UUID 会加上 pi: 前缀，作为 TencentDB 的 session ID。自动召回默认在
当前 Team、Agent、User 隔离范围内跨会话搜索；对话搜索工具可选择只查当前 Pi
会话。

## 验证

启动 Pi 后执行：

~~~text
/tdai-memory-status
~~~

完成一轮对话后，可以通过 SDK 或 API 检查 L0：

~~~bash
curl -sS "$TDAI_MEMORY_ENDPOINT/v3/conversation/query" \
  -H "Authorization: Bearer $TDAI_MEMORY_API_KEY" \
  -H "x-tdai-service-id: $TDAI_MEMORY_SERVICE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "team_id": "'"$TDAI_MEMORY_TEAM_ID"'",
    "agent_id": "'"$TDAI_MEMORY_AGENT_ID"'",
    "user_id": "'"$TDAI_MEMORY_USER_ID"'",
    "limit": 10
  }'
~~~

## 开发与测试

~~~bash
cd adapters/pi
npm install --ignore-scripts
npm run check
npm run pack:check
~~~

测试覆盖配置安全、v3 请求契约、部分召回、Prompt 注入边界、生命周期采集、去重、
搜索工具和故障降级。

## 已知边界

- 适配器不会创建 Team、Agent 或 User。请先在 Memory Hub 中创建，并通过环境变量
  传入对应 ID。
- v3 数据面暂时没有场景语义搜索接口，因此 L2 使用列表接口返回的有限条摘要。
- 成功采集会通过不进入模型上下文的会话条目跨 Pi reload 去重。如果服务端已写入、
  但响应在网络中丢失，当前 conversation-add 接口又会自行生成消息 ID，此类不确定
  失败仍可能造成一次重复写入。
- 召回记忆只是模型上下文，不是鉴权机制；隔离与访问控制仍由 MemoryCore 负责。

## 参考资料

- [Pi 扩展文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi 包文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)

## 许可证

MIT，与父仓库保持一致。
