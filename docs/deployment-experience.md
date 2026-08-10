# TencentDB Agent Memory 部署与使用经验

> 本文档总结了 TencentDB Agent Memory 项目的核心功能、部署流程、API 测试验证，以及在实际部署中积累的踩坑经验和最佳实践。

---

## 一、项目简介

### 1.1 是什么

TencentDB Agent Memory 是一个面向 Agent 团队的**记忆管理系统**，解决的核心问题是：**让 Agent 的经验可沉淀、可复用、可继承**。

传统 Agent 每次对话都从零开始——文档要重读、上下文要重建、经验无法传递。TencentDB Agent Memory 通过分层记忆架构，让 Agent 团队能够：

- **记住对话**：跨会话保留偏好、事实、决策和交互历史
- **沉淀经验**：从对话中自动提炼可复用的 Skill 和知识
- **团队共享**：记忆资产可在团队内流动，新 Agent 直接"读档"继承
- **按需召回**：不是把所有记忆塞进 Prompt，而是根据当前问题精准检索

### 1.2 核心架构：L0-L3 分层记忆

```
L0 Conversation  →  原始对话（完整上下文）
       ↓ Pipeline + LLM 提取
L1 Atom          →  原子记忆（事实、偏好、约束、事件）
       ↓ 聚合
L2 Scenario      →  场景记忆（围绕项目/场景的知识块）
       ↓ 提炼
L3 Core/Persona  →  核心记忆（长期画像、稳定模式）
```

| 层级 | 保存什么 | 主要用途 | 隔离维度 |
|------|---------|---------|---------|
| L0 | 原始对话与完整上下文 | 核对原话、时间和来源 | team + user + agent |
| L1 | 从对话提取的事实、偏好、约束 | 精确召回可执行信息 | team + user + agent |
| L2 | 围绕项目或场景组织的知识块 | 快速恢复工作场景 | team + agent（忽略 user） |
| L3 | 长期画像、稳定模式与高层认知 | 让 Agent 迅速进入语境 | team + agent（忽略 user） |

**关键设计决策**：L2/L3 按 `team + agent` 隔离、故意忽略 `user_id`——因为场景知识和人设画像是 Agent 级别的，不应因用户不同而分裂。

### 1.3 系统组件

| 组件 | 端口 | 职责 |
|------|------|------|
| Memory Core | 8420 | 记忆读写、Pipeline、鉴权、数据面 |
| Memory Hub (Panel) | 8125 | 团队记忆管理面板 UI |
| Knowledge Service | 8424 | Wiki / CodeGraph 服务 |
| Proxy | 8096 | LLM 请求代理（Anthropic/OpenAI 双协议） |

### 1.4 技术栈

- **运行时**：Node.js ≥ 22.16，TypeScript
- **存储**：SQLite（standalone 模式）/ TDSQL-C（集群模式）
- **向量检索**：sqlite-vec 扩展（可选）+ BM25 全文检索
- **LLM**：支持任意 OpenAI 兼容 API（阿里云百炼、OpenAI、DeepSeek 等）
- **部署**：Docker 容器化，一键脚本

---

## 二、部署流程

### 2.1 环境要求

- Docker + Docker Compose
- 一个可用的 LLM API（OpenAI 兼容协议）
- 端口：8420、8125、8424、8096

### 2.2 一键部署（完整三件套）

```bash
git clone https://github.com/TencentCloud/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory/deploy/global-images
cp .env.example .env
$EDITOR .env       # 填入 LLM 参数
./start-all.sh     # 一键启动
```

### 2.3 .env 关键配置

```bash
# ── Memory Core / Hub 内部 LLM ──
MEMORY_LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MEMORY_LLM_API_KEY=sk-xxx
MEMORY_LLM_MODEL=qwen3.8-max

# ── Proxy 上游 LLM ──
PROXY_UPSTREAM_URL=https://api.anthropic.com
PROXY_UPSTREAM_API_KEY=sk-ant-xxx
PROXY_UPSTREAM_MODEL=claude-sonnet-4-20250514

# ── Embedding（可选，默认关闭）──
MEMORY_EMBEDDING_PROVIDER=openai
MEMORY_EMBEDDING_MODEL=qwen3.7-text-embedding
MEMORY_EMBEDDING_DIMENSIONS=1024
```

### 2.4 单独部署 Memory Core

如果只需要记忆服务（不需要 Hub/Proxy），可以单独启动：

```bash
cd deploy/global-images
bash start-memory-core.sh
```

启动后验证：

```bash
curl -s http://localhost:8420/health | jq .status
# 期望输出: "ok"
```

### 2.5 部署后验证清单

```bash
# 1. 健康检查
curl -s http://localhost:8420/health | jq '{status, stores, services}'

# 2. 确认 Pipeline Worker 正常
curl -s http://localhost:8420/health | jq .services.pipelineWorker

# 3. 确认存储状态
curl -s http://localhost:8420/health | jq .stores
```

---

## 三、API 使用指南

### 3.1 鉴权机制

所有 API 请求需要携带两个 Header：

```
Authorization: Bearer <api_key>
x-tdai-service-id: <service_id>
```

- `Authorization`：Bearer Token，standalone 模式下为任意非空字符串
- `x-tdai-service-id`：服务实例 ID，本地部署固定为 `default`

### 3.2 核心 API 路由表

| 层级 | 端点 | 方法 | 说明 |
|------|------|------|------|
| L0 | `/v2/conversation/add` | POST | 添加对话消息 |
| L0 | `/v2/conversation/query` | POST | 查询对话历史 |
| L0 | `/v2/conversation/search` | POST | 搜索对话 |
| L0 | `/v2/conversation/delete` | POST | 删除消息 |
| L0 | `/v3/conversation/count` | POST | 对话计数 |
| L1 | `/v2/atomic/query` | POST | 查询原子记忆 |
| L1 | `/v2/atomic/search` | POST | 搜索原子记忆 |
| L1 | `/v2/atomic/update` | POST | 更新原子记忆 |
| L1 | `/v2/atomic/delete` | POST | 删除原子记忆 |
| L1 | `/v3/atomic/count` | POST | 原子记忆计数 |
| L2 | `/v2/scenario/ls` | POST | 列举场景文件 |
| L2 | `/v2/scenario/read` | POST | 读取场景文件 |
| L2 | `/v2/scenario/write` | POST | 更新场景文件（非 upsert） |
| L2 | `/v2/scenario/rm` | POST | 删除场景文件 |
| L2 | `/v3/scenario/count` | POST | 场景计数 |
| L3 | `/v2/core/write` | POST | 写入核心记忆 |
| L3 | `/v2/core/read` | POST | 读取核心记忆 |
| L3 | `/v3/core/count` | POST | 核心记忆计数 |
| Pipeline | `/v2/pipeline/status` | POST | 查询 Pipeline 状态 |

### 3.3 请求体通用字段

所有数据面 API 都需要携带身份三元组：

```json
{
  "team_id": "your-team-id",
  "user_id": "your-user-id",
  "agent_id": "your-agent-id"
}
```

### 3.4 使用示例

**添加对话（自动触发 L1 提取）：**

```bash
curl -X POST http://localhost:8420/v2/conversation/add \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-key" \
  -H "x-tdai-service-id: default" \
  -d '{
    "team_id": "team-1",
    "user_id": "user-1",
    "agent_id": "agent-1",
    "session_id": "session-001",
    "messages": [
      {"role": "user", "content": "我喜欢用 Python 写代码"},
      {"role": "assistant", "content": "好的，我记住了您偏好 Python"}
    ]
  }'
```

**搜索记忆：**

```bash
curl -X POST http://localhost:8420/v2/atomic/search \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-key" \
  -H "x-tdai-service-id: default" \
  -d '{
    "team_id": "team-1",
    "user_id": "user-1",
    "agent_id": "agent-1",
    "query": "Python",
    "limit": 5
  }'
```

---

## 四、Embedding 配置

### 4.1 默认状态

默认部署中 embedding 是**关闭的**（`provider: none`），检索走纯 BM25 关键词匹配。

### 4.2 开启向量检索

在 `.env` 中添加：

```bash
MEMORY_EMBEDDING_PROVIDER=openai
MEMORY_EMBEDDING_MODEL=qwen3.7-text-embedding
MEMORY_EMBEDDING_DIMENSIONS=1024
```

embedding 配置会复用 LLM 的 `baseUrl` 和 `apiKey`（除非单独指定 `MEMORY_EMBEDDING_BASE_URL` / `MEMORY_EMBEDDING_API_KEY`）。

### 4.3 支持的 Embedding 模型

| 模型 | 维度 | Provider |
|------|------|----------|
| qwen3.7-text-embedding | 1024 | dashscope (OpenAI 兼容) |
| text-embedding-v3 | 1024 | dashscope |
| text-embedding-3-small | 1536 | OpenAI |
| text-embedding-3-large | 3072 | OpenAI |

### 4.4 切换 Embedding 的影响

- 首次启用或更换模型/维度时，系统会**自动丢弃旧向量表并重建索引**
- 已有数据会在后台逐步重新 embedding
- 新写入的数据会实时生成向量
- 检索接口升级为 hybrid（向量 + BM25）语义检索

### 4.5 重要注意

**聊天模型不能当 embedding 模型用**。`qwen3.8-max` 等聊天模型不支持 `/embeddings` 端点，必须使用专门的 embedding 模型（如 `qwen3.7-text-embedding`）。

---

## 五、Pipeline 机制

### 5.1 触发方式

Pipeline 由 `conversation/add` **自动触发**，没有手动 trigger 端点。流程：

```
conversation/add → 自动入队 → Pipeline Worker 消费 → LLM 提取 L1 → 聚合 L2 → 提炼 L3
```

### 5.2 时间预期

| 阶段 | 耗时 | 说明 |
|------|------|------|
| L1 提取 | ~60s | 取决于 LLM 响应速度 |
| L2 聚合 | 30min（默认 l2Delay） | 等待足够对话积累 |
| L3 提炼 | 更长 | 需要多次 L2 积累 |

### 5.3 监控 Pipeline

```bash
# 查看 Pipeline 状态
curl -X POST http://localhost:8420/v2/pipeline/status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer key" \
  -H "x-tdai-service-id: default" \
  -d '{"team_id":"t","user_id":"u","agent_id":"a"}'

# 查看 Worker 统计
curl -s http://localhost:8420/health | jq .services.pipelineWorker
# 关注: tasksConsumed（已消费）、tasksFailed（失败数，应为 0）
```

### 5.4 当前版本限制

- `pipeline/pause` 和 `pipeline/resume` 端点**尚未实现**（返回 404）
- 只有 `pipeline/status` 可用

---

## 六、测试验证经验

### 6.1 测试脚本

项目中保留了 `test-core-api-v2.sh`，覆盖 32 个用例：

```bash
# 在服务器上执行
scp test-core-api-v2.sh root@<server>:/tmp/
ssh root@<server> "bash /tmp/test-core-api-v2.sh"
```

### 6.2 测试结果（2026-08-08）

| 指标 | 数值 |
|------|------|
| 总用例 | 32 |
| 通过 | 28 |
| 跳过 | 2（L2 环境限制） |
| N/A | 2（pipeline pause/resume 未实现） |
| 已实现功能通过率 | **100%** |

### 6.3 测试中的关键发现

1. **L1 提取需要等待**：`conversation/add` 后需等 ~60s 才能查到 L1 结果
2. **scenario/write 非 upsert**：目标文件必须已存在（由 L2 pipeline 生成），否则返回 404
3. **L2/L3 跨 user 共享是设计行为**：不是 bug
4. **鉴权只校验存在性**：standalone 模式下 Bearer Token 只需非空

---

## 七、踩坑记录与最佳实践

### 7.1 部署脚本会覆盖配置

`start-memory-core.sh` 每次启动都会**重新生成** `tdai-gateway.yaml`。如果你手动修改了配置文件，重启后会被覆盖。

**解决方案**：修改 `.env` 中的环境变量，或修改脚本中的 heredoc 模板。

### 7.2 SSH 内联 JSON 转义问题

通过 SSH 直接执行含 JSON 的 curl 命令时，引号转义极易出错。

**最佳实践**：将测试脚本写成本地文件，`scp` 上传后在远程执行：

```bash
scp test.sh root@server:/tmp/
ssh root@server "bash /tmp/test.sh"
```

### 7.3 API 路径不要猜

路由表以 `MemoryCore/src/gateway/v2-router.ts` 为准。常见错误：

| 错误路径 | 正确路径 |
|---------|---------|
| `/v2/conversation/list` | `/v2/conversation/query` |
| `/v2/conversation/history` | `/v2/conversation/query` |
| `/v2/pipeline/trigger` | 不存在（自动触发） |
| `/v2/pipeline/pause` | 未实现 |

### 7.4 Embedding 与 LLM 是独立配置

embedding 有自己的 `provider`、`model`、`dimensions` 配置，不要假设聊天模型能兼任 embedding。但它们可以共用同一个 `baseUrl` 和 `apiKey`。

### 7.5 数据隔离语义

- L0/L1：`team + user + agent` 三维隔离
- L2/L3：`team + agent` 二维隔离（忽略 user_id）

测试时如果跨 user 读到了 L3 数据，这是**正确行为**，不是隔离泄漏。

### 7.6 promptMode 影响 L1 提取

- `chat` 模式：适合普通对话，能抽出偏好、事实
- `code` 模式：适合编程对话，如果对话都是闲聊会返回 0 条提取

### 7.7 DeepSeek thinking 模式 400：`reasoning_content` 缺失

**现象**：走完表单注册后，Proxy 转发给 DeepSeek 上游时收到 400：

```
The reasoning_content in the thinking mode must be passed back to the API.
```

**根因**：Proxy 表单交互产生的 assistant `tool_calls` 消息没有 `reasoning_content` 字段。DeepSeek thinking 模型要求消息历史中**每个 assistant 消息**都必须带 `reasoning_content`，真实用户走完表单后同样会撞上这个错误。

**修复**：`MemoryProxy/src/handler.ts` 新增 `patchMissingReasoningContent()`，在 `buildUpstreamBody()` 转发前给缺失该字段的 assistant 消息补空串：

```ts
// assistant 消息缺 reasoning_content → 补空串，保留正常思考能力
if (msg.role !== "assistant") return m;
if (msg.reasoning_content !== undefined) return m;
return { ...msg, reasoning_content: "" };
```

三种方案对比验证（直打 DeepSeek API）：
| 方案 | 结果 |
|------|------|
| assistant 消息补 `reasoning_content:""` | ✅ 200，保留思考 |
| 请求带 `thinking:{"type":"disabled"}` | ✅ 200，但禁用思考 |
| 不做处理 | ❌ 400 |

**注意**：补丁只在运行中的容器内生效（`docker cp` 热更新），**下次重建镜像需重新构建**。

### 7.8 meta API 间歇性超时 → 表单不弹出

**现象**：新会话不发表单、直接放行。Proxy 日志：

```
[session-init:cb] kernel unavailable for user=..., passing through unintercepted:
  [metadata-client] /v3/meta/task/list fetch failed: timeout
```

**排查过程**：
1. 宿主机 `curl localhost:8420/v3/meta/task/list` GET → 404 —— **方法不对**。metadata-client 用 **POST + `x-tdai-user-key` header**（还需要 `Authorization` + `x-tdai-service-id`）。
2. Proxy 容器内用正确方法复测 → 全部 200（0.1~0.9s），memory-core 正常。
3. Proxy 的 `coreSkill.timeoutMs = 5000`，而 memory-core 的 `auth/verify` 偶发 1.5s+；Node `fetch` 直连也全部 200 —— 之前的 timeout 是**瞬态**（重启瞬间 / 冷启动）。

**结论**：
- `kernel unavailable` 时 Proxy **bypass 且不弹表单**，这是设计行为（无法构建表单选项就不拦截）。
- meta 慢（容器刚重启、冷启动）时会导致新会话注册失败，排障时先在 proxy 容器内用**正确方法**复测 meta 端点，避免误判。

### 7.9 注入硬性要求 team + agent + task 三元组

**现象**：表单注册成功，但日志显示：

```
[session-init:cb] session=... agent=... without task → bypass (task required for injection)
```

**根因**：团队里**没有 running 的 task**（`task/list` 返回空）。注入器要求 `team + agent + task` 三者齐全，缺 task 即使选了 agent 也会 bypass 跳过注入。

**修复**：通过 `/v3/meta/task/create` 创建 running task（默认 `running`）：
- 必填字段（`taskCreateSchema`）：`team_id`、`creator_user_id`、`title`
- `assertCallerIsResourceOwner` 要求 `creator_user_id` 必须是调用者自己

### 7.10 会话表单链路验证经验

模拟 CodeBuddy 新会话完整交互（Python 脚本直连 Proxy）：

| 轮次 | 交互 | 关键点 |
|------|------|--------|
| R1 | 新会话发消息 | 返回 `asset_confirm` 表单（是否关联团队资产） |
| R2 | 回答"是" | **单 team 自动预选**，直接进 agent/task 表单 |
| R3 | 选 agent + task | 注册成功，转发上游 |
| R4 | 真实请求 | 注入生效（`reasoning_content` 可见注入上下文） |

验证注入是否生效的核心日志：
```
[injection] ✓ Hook "skill-tools-injector" injected 1 block(s) at point "system.before_tools"
[injection] ✓ Hook "tdai-memory-tools-injector" injected 1 block(s) at point "system.suffix"
```

注意：`max_tokens` 过小时响应 `content` 可能为空（全被 thinking 消耗，`finish_reason: length`），不是注入失败；以日志和上游 `reasoning_content` 为准。

---

## 八、接入 Coding Agent

### 8.1 通过 Proxy 接入 Claude Code

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8096/claude-code/default
export ANTHROPIC_AUTH_TOKEN="sk-mem-xxx"  # 业务用户 user_key
claude --model <上游模型名>
```

首次会话会弹出 Team → Agent → Task 选择表单。

### 8.2 通过 Proxy 接入 CodeBuddy

在 `~/.codebuddy/models.json` 中配置：

```json
{
  "models": [{
    "id": "claude-sonnet-4-20250514",
    "name": "proxy-memory-agent",
    "vendor": "claude",
    "apiKey": "<user_key>",
    "maxInputTokens": 200000,
    "url": "http://127.0.0.1:8096/codebuddy/default",
    "supportsToolCall": true,
    "supportsImages": true
  }]
}
```

> 注意：CodeBuddy 4.10.2-4.10.4 有已知 Bug（不携带 sessionId），请使用 ≥ 4.10.5。

### 8.3 通用接入（任意 OpenAI 兼容平台）

将 API base URL 指向 Proxy：

```
http://<proxy-host>:8096/<agent-source>/<spaceId>
```

必须携带 Header：
- `Authorization: Bearer <user_key>`
- `x-team-id`
- `x-agent-id`
- `x-task-id`（当前版本必填）
- `x-conversation-id`

---

## 九、运维要点

### 9.1 数据持久化

- SQLite 数据存储在 Docker volume 中
- `stop-all.sh` 保留数据；`stop-all.sh --purge` 清除所有数据
- Admin key 持久化在 `.admin-key` 文件中

### 9.2 日志排查

```bash
# Memory Core 日志
docker logs tdai-memory-core --tail 100

# 查看 embedding 状态
docker logs tdai-memory-core 2>&1 | grep -i embed

# 查看 pipeline 活动
docker logs tdai-memory-core 2>&1 | grep -i pipeline
```

### 9.3 健康检查关键字段

```json
{
  "status": "ok",
  "stores": {
    "embeddingService": true,   // embedding 是否启用
    "vectorStore": true,        // 向量存储是否可用
    "strategy": "hybrid"        // 检索策略: hybrid | bm25 | vector
  },
  "services": {
    "pipelineWorker": {
      "tasksConsumed": 128,     // 已处理任务数
      "tasksFailed": 0          // 失败数（应为 0）
    }
  }
}
```

---

## 十、总结

TencentDB Agent Memory 的核心价值在于将 Agent 的"一次性对话"转变为"可积累的团队资产"。部署简单（Docker 一键起），配置灵活（支持任意 OpenAI 兼容 LLM），API 设计清晰（L0-L3 分层 + 身份三元组隔离）。

**关键经验**：
1. 先跑通 L0 → L1 链路（conversation/add → 等 60s → atomic/query）
2. Embedding 是可选增强，BM25 已经能用，但语义检索效果更好
3. 不要猜测 API 路径，以源码路由表为准
4. L2/L3 的隔离语义与 L0/L1 不同，这是设计决策
5. Pipeline 是异步的，测试时需要留足等待时间
6. 表单注入链路要求 team + agent + task 三元组齐全，缺 task 会静默 bypass
7. 上游用 DeepSeek thinking 模型时，Proxy 生成的表单 assistant 消息必须补 `reasoning_content`，否则 400（见 7.7）
8. `kernel unavailable` 时 Proxy 不弹表单直接放行是设计行为，meta 偶发超时别误判（见 7.8）
9. 修改容器内源码后需 `docker restart tdai-proxy` 且等待 healthy，重建镜像会丢失热更新
