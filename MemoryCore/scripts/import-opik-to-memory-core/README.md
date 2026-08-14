# Opik → Memory Core 导入工具

将 Opik Project 下的 Trace 转换为对话消息，并通过 Memory Core Gateway 的 `POST /v3/conversation/add` 写入 L0。

## 能力

- 自动分页读取全部 Opik Projects 和指定 Project 的全部 Traces
- 支持按 Project 名称或 UUID 选择项目
- 识别 `messages`、`conversation`、`history`、`prompt/response`、OpenAI `choices` 等常见 Trace 结构
- 自动合并 input/output 消息、消除重叠并限制单条消息和单批大小
- 写入前按 Session 预检；预计超过 4 万条 L0 时，跨 Trace 去重并优先导入最新尾部快照
- 支持 Dry Run、断点续传、网络重试和 Pipeline 节流
- 密钥只从环境变量读取

## 前置条件

- Node.js `>= 22.16.0`
- 已安装当前项目依赖
- Opik REST API 可访问
- 远端 Memory Core Gateway 可访问 `/health`、`/v3/conversation/add` 和 `/v3/conversation/query`
- 已确定目标 `service_id`、`team_id`、`agent_id` 和 `user_id`

进入 Memory Core 目录：

```bash
cd MemoryCore
```

查看全部参数：

```bash
npm run import:opik -- --help
```

## Opik 地址与分页

推荐只配置 Opik 根地址和 workspace：

```bash
export OPIK_URL='http://opik.example.com:5173'
export OPIK_WORKSPACE='default'
```

也兼容 UI 地址：

```text
http://opik.example.com:5173/default/projects?size=25
```

UI URL 中的 `size=25` 不会限制导入范围。工具会转换为 `/api/v1/private` API 地址，并按 `page`、`size` 自动读取全部分页；`--page-size` 默认是 `100`。

## 配置远端 Memory Core

以下地址仅为示例，请替换成实际 Gateway 地址：

```bash
export MEMORY_CORE_URL='http://memory-core.example.com:8423'
export MEMORY_CORE_SERVICE_ID='default'
export MEMORY_CORE_TEAM_ID='team-001'
export MEMORY_CORE_AGENT_ID='agent-001'
export MEMORY_CORE_USER_ID='user-001'
```

可选 Task 隔离：

```bash
export MEMORY_CORE_TASK_ID='task-001'
```

不需要 Task 时：

```bash
unset MEMORY_CORE_TASK_ID
```

安全输入 API Key，避免写入代码或配置文件：

```bash
read -s "MEMORY_CORE_API_KEY?Memory Core API Key: "
echo
export MEMORY_CORE_API_KEY
```

检查 Gateway：

```bash
curl --fail --silent --show-error "${MEMORY_CORE_URL}/health"
```

## 先执行 Dry Run

Dry Run 会读取真实 Opik 并转换 Trace，但不会写入 Memory Core 或断点文件：

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --max-traces 5 \
  --dry-run
```

`--project` 同时接受 Project 名称和 UUID，可以重复传入或使用逗号分隔：

```bash
npm run import:opik -- \
  --project 'project-a' \
  --project '019fb2e2-16a9-717d-98a8-0cd2e1bef87e' \
  --dry-run
```

不传 `--project` 会处理 workspace 下全部项目。项目数量较多时，应先指定项目和 `--max-traces` 做小批验证。

## 正式导入

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --max-traces 5 \
  --state-file './opik-import-remote-state.json'
```

成功时会输出：

```text
[import] project=... trace=... accepted=...
[done] seen_traces=5 imported_traces=5 ... imported_messages=...
```

工具实际调用：

```text
POST <MEMORY_CORE_URL>/v3/conversation/add
```

写入范围由以下字段共同决定：

- `x-tdai-service-id`: `MEMORY_CORE_SERVICE_ID`
- `team_id`: `MEMORY_CORE_TEAM_ID`
- `agent_id`: `MEMORY_CORE_AGENT_ID`
- `user_id`: `MEMORY_CORE_USER_ID`
- `task_id`: `MEMORY_CORE_TASK_ID`，可选
- `session_id`: 根据 Opik Project ID 和 `thread_id`/Trace ID 稳定生成

每条消息会把 Opik 原始时间同时写入：

- `timestamp`：消息实际发生时间
- `recorded_at`：L0 入库排序时间，对应 TCVDB 的 `recorded_at_ms`

因此面板按 `recorded_at_ms desc` 排序时，会按 Opik 历史时间展示，而不是按本次导入执行时间展示。未显式传入 `recorded_at` 的普通 Memory Core 写入仍使用服务端接收时间。

## 超大 Session 保护

默认 `--max-session-messages 40000`。这里统计的是 L0 消息条数，不是 user/assistant 配对后的“轮数”；4 万条消息约等于 2 万轮标准问答，低于已知的单 Session 5 万条风险边界。

工具会先按目标 `session_id` 汇总本次将处理的 Trace。若同一 Session 预计写入超过上限：

1. 按 Trace 时间顺序合并累计对话，消除前一个 Trace 历史在后一个 Trace 中重复出现的问题；
2. 只保留去重后最新的 N 条消息；
3. 优先写入一个独立的尾部快照 Session，ID 形如 `原session:t40000:<快照哈希>`；
4. 不再把该源 Session 的旧 Trace 逐条写入，因此单个新 Session 不会超过配置上限。

独立快照 ID 会随尾部内容变化。数据源后续新增消息时会生成新的快照 Session，避免继续向旧 Session 追加并重新突破上限。

Dry Run 检查超大 Session：

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --max-session-messages 40000 \
  --large-session-strategy tail \
  --dry-run
```

如果不允许截断，希望发现超限就停止：

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --max-session-messages 40000 \
  --large-session-strategy error \
  --dry-run
```

使用 `--max-session-messages 0` 可以关闭保护，但对于可能超过 5 万条 L0 的 Session 不建议这样做。

## 断点续传

默认启用断点续传。每个成功批次会立即写入 `--state-file`，重新执行相同命令时自动跳过已完成批次：

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --state-file './opik-import-remote-state.json'
```

忽略已有断点：

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --no-resume
```

`--no-resume` 可能造成重复导入，只应在明确需要重新导入时使用。断点文件权限为 `0600`，但其中不保存 API Key。

## Pipeline 策略

默认每写入 20 个批次等待 L1 空闲，并在结束时等待 L1/L2/L3 全部空闲。

如果目标环境关闭了记忆提取、只需要写 L0：

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --wait-every 0 \
  --no-final-wait \
  --state-file './opik-import-remote-state.json'
```

## 回查导入结果

```bash
curl --fail --silent --show-error \
  -X POST "${MEMORY_CORE_URL}/v3/conversation/query" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${MEMORY_CORE_API_KEY}" \
  -H "x-tdai-service-id: ${MEMORY_CORE_SERVICE_ID}" \
  --data "$(cat <<JSON
{
  \"team_id\": \"${MEMORY_CORE_TEAM_ID}\",
  \"agent_id\": \"${MEMORY_CORE_AGENT_ID}\",
  \"user_id\": \"${MEMORY_CORE_USER_ID}\",
  \"limit\": 100,
  \"offset\": 0
}
JSON
)"
```

## Opik 鉴权

自托管 Opik 默认可能不需要鉴权。启用鉴权时：

```bash
read -s "OPIK_API_KEY?Opik API Key: "
echo
export OPIK_API_KEY
export OPIK_AUTH_SCHEME='Bearer'
```

`OPIK_AUTH_SCHEME` 为空时，`OPIK_API_KEY` 会原样作为 `Authorization` Header。

## 常用参数

| 参数 | 默认值 | 说明 |
|---|---:|---|
| `--project` | 全部项目 | Project 名称或 UUID，可重复或逗号分隔 |
| `--page-size` | `100` | Opik API 每页数量 |
| `--max-traces` | `0` | 本次最多处理的 Trace 数，`0` 表示不限 |
| `--max-session-messages` | `40000` | 单个目标 Session 最多写入的 L0 消息数，`0` 禁用保护 |
| `--large-session-strategy` | `tail` | 超限时保留最新尾部；`error` 表示直接停止 |
| `--state-file` | `.opik-memory-import-state.json` | 断点文件 |
| `--dry-run` | 关闭 | 只拉取和转换，不写入 |
| `--no-resume` | 关闭 | 忽略断点，可能重复导入 |
| `--include-system` | 关闭 | 将 system/developer 转成带前缀的 user 消息 |
| `--wait-every` | `20` | 每 N 个写请求等待 L1，`0` 禁用 |
| `--no-final-wait` | 关闭 | 不等待最终 L1/L2/L3 空闲 |
| `--timeout-ms` | `30000` | 单次 HTTP 请求超时 |
| `--retries` | `4` | 网络错误、429 和 5xx 重试次数 |

## 已验证链路

该工具已使用真实 Opik API 和隔离的本地 Memory Core 完成端到端验证：

1. 分页读取 Opik Project 和 Trace
2. 将 5 个 Trace 转换为 15 条 L0 消息
3. 写入 `/v3/conversation/add`
4. 通过 `/v3/conversation/query` 回查 15 条消息
5. 重复执行时断点命中、写入数为 0
6. SQLite 与 JSONL 镜像落盘数量一致
