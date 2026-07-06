# Dify 适配器 — 外部知识库 + 自定义工具

> English version: [README.md](./README.md)。
> 构建于 [Adapter SDK](../../adapter-sdk/README_CN.md) · 与其他平台的对比见
> [PLATFORM-COMPARISON_CN.md](../../../docs/adapters/PLATFORM-COMPARISON_CN.md)

`DifyMemoryAdapter` 通过 [Dify](https://dify.ai) 自身的两个扩展点接入 TDAI 记忆引擎 —
Dify 内部不运行我们任何代码：

- **读 — 外部知识库 API。** Dify 在知识检索时调用本适配器的 `POST /retrieval`。提供两个
  虚拟知识库：`tdai-memories`（L1 结构化记忆）与 `tdai-conversations`（L0 原始对话）。
- **写 — 自定义工具。** `POST /tools/capture`（及 `POST /tools/recall`）由 `GET /openapi.json`
  生成的 OpenAPI 3.1 规范描述，可导入 Dify 作为自定义工具，让 Agent/工作流节点把对话
  写入记忆。

## 运行

```bash
npm run gateway        # 记忆后端（默认 http 传输）
TDAI_DIFY_API_KEY=dify-secret npm run adapter:dify   # 适配器监听 http://127.0.0.1:8421
```

| 变量 | 含义 | 默认 |
| --- | --- | --- |
| `TDAI_DIFY_PORT` / `TDAI_DIFY_HOST` | 监听地址 | `8421` / `127.0.0.1` |
| `TDAI_DIFY_API_KEY` | Dify 必须携带的 Bearer 密钥（强烈建议设置） | 未设 → 开放模式 + 启动 WARN |
| `TDAI_DIFY_SESSION_KEY` | /tools/* 的默认会话 | `dify:default` |
| `TDAI_ADAPTER_TRANSPORT` / `TDAI_GATEWAY_URL` / `TDAI_GATEWAY_API_KEY` / `TDAI_ADAPTER_TIMEOUT_MS` | 记忆后端选择（SDK 共享约定） | `http` / `http://127.0.0.1:8420` / 未设 / `10000` |

注意：Dify 跑在 Docker 里时，从 Dify 容器内访问适配器的地址是
`http://host.docker.internal:8421`（而不是 `127.0.0.1`）。

## Dify 控制台操作指引

### A. 记忆读取（知识检索）

1. **知识库 → 外部知识库 API → 添加**：名称 `tdai-memory`，
   API Endpoint `http://host.docker.internal:8421`（Dify 会自动拼上 `/retrieval`），
   API Key 填你的 `TDAI_DIFY_API_KEY`。
2. **知识库 → 创建知识库 → 连接外部知识库**：外部知识库 ID 填 `tdai-memories`
   （查原始历史则填 `tdai-conversations`）。
3. 在应用里把该知识库加入**上下文**（Chatflow 则添加知识检索节点）。此后 Dify 每次用户
   提问都会调用 `/retrieval`。返回记录的 `score` 会按批归一化（各自除以该批最大值，
   最高命中 = `1.0`）—— 因为引擎混合检索的 RRF 原始分远小于 1，所以 `score_threshold`
   实际是批内的*相对*阈值；`top_k` 原生生效。

### B. 记忆写入（自定义工具）

1. **工具 → 自定义 → 创建自定义工具**，粘贴 `http://127.0.0.1:8421/openapi.json` 返回的
   JSON（schema 导入），鉴权选 `Bearer` + 你的密钥。
2. 出现两个工具：`memory_capture` 与 `memory_recall`。
3. Agent 应用：直接启用工具 — 模型会在值得记住的交流后调用 `memory_capture`。
   工作流/Chatflow：在 LLM 节点后加工具节点，映射 `user_content` ← 用户提问、
   `assistant_content` ← LLM 输出，并（建议）`session_key` ← 会话变量，如
   `dify:{{#sys.user_id#}}`。

### 一次完整对话回合（召回 → 回答 → 捕获）

```
用户提问 ──▶ 知识检索节点 ──POST /retrieval──▶ 适配器 ──▶ 记忆引擎
                  │（带分数的 records）
                  ▼
             LLM 节点（上下文 = 检索到的记忆）
                  │
                  ▼
          memory_capture 工具节点 ──POST /tools/capture──▶ 适配器 ──▶ 记忆引擎
```

## 协议契约（按 Dify 外部知识库 API 规范实现）

- `POST /retrieval` 请求：`{ knowledge_id, query, retrieval_setting: { top_k, score_threshold } }`。
  响应：`{ records: [{ content, score, title, metadata }] }`。
  - `tdai-memories` 记录：`title` = 场景名（无则记忆类型），metadata `{id, type, scene_name, created_at}`。
  - `tdai-conversations` 记录：`title` = `role@session_key`，metadata `{id, role, session_key, recorded_at}`。
  - `top_k` 收敛到 1..20；缺省 `retrieval_setting` 时默认 `top_k=5, threshold=0`。
  - `score` 在过滤前按批归一化到 0..1（最高命中 = 1.0），`score_threshold` 是相对阈值。
- 鉴权错误采用 Dify 规定的响应体：缺失/格式错误的头 → HTTP 403
  `{"error_code": 1001, "error_msg": "Invalid Authorization header format..."}`；密钥错误 →
  403 `{"error_code": 1002, "error_msg": "Authorization failed"}`；未知 `knowledge_id` →
  404 `{"error_code": 2001, "error_msg": "The knowledge does not exist"}`。
- `GET /health`（免鉴权）：`{ status, platform: "dify", upstream }` — 永不抛错；记忆后端
  不可达时报告 `"unreachable"`。

## 设计要点

- 依托 SDK 的结构化搜索（逐条带分数的 `items`）— gateway 协议为此新增了向后兼容的
  `include_items` 可选字段。若后端是没有 `items` 的旧版 gateway，适配器降级为返回单条
  格式化文本记录，而不是失败。
- 零依赖 `node:http` 服务器、常量时间密钥比较、与 Gateway 一致的安全姿态启动告警。
