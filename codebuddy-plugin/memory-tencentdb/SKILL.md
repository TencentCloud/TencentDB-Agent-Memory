---
name: memory-tencentdb
description: 为 CodeBuddy 提供基于 TencentDB Agent Memory 的长期记忆能力（L0 对话→L1 结构化记忆→L2 场景→L3 画像）。当用户希望"记住偏好/记住我说过的话/长期记忆/跨会话记忆"，或希望"召回历史记忆/检索之前的对话/想起上次聊过什么"，或提到"记忆插件/memory/记住这个/别忘了"时应触发。此 Skill 通过本地 Gateway（HTTP 127.0.0.1:8420）在每轮对话开始时自动召回相关记忆、对话结束后自动捕获本轮内容，并支持按需检索结构化记忆与历史会话。
version: 1.0.0
---

## 目的

让 CodeBuddy 具备与原 OpenClaw 记忆插件等价的长期记忆体验：

- **自动召回**：每轮回答前，从历史记忆中检索与当前问题相关的上下文并融入回答。
- **自动捕获**：每轮回答后，把本轮 user/assistant 内容写入记忆管线（L0→L1→L2→L3）。
- **按需检索**：用户明确要求"想起/翻一下之前"时，检索结构化记忆或历史会话。

底层复用仓库既有的、与宿主解耦的 Gateway HTTP 服务（`src/gateway/server.ts`），本 Skill 仅作薄封装：用 `scripts/memory-client.mjs` 调用 Gateway，用 `scripts/gateway-up.sh` 自动托管 Gateway 进程。

## 适用场景

- 用户表达希望被"记住"的偏好、约定、事实（如技术栈、命名习惯、项目背景）。
- 用户希望召回之前对话或之前定下的结论。
- 用户明确要求检索记忆 / 历史会话。

## 不适用场景

- 一次性、无需跨会话保留的纯计算/查询类问答（可不触发，避免额外开销）。
- Gateway 依赖（PostgreSQL / LLM / Embedding）尚未配置完成时——应先引导用户运行安装脚本（见"首次安装"）。

## 关键约定

### session_key（记忆命名空间）

`session_key` 决定记忆如何分组与隔离，必须在 recall 与 capture 间保持一致：

- **用户级安装（跨项目共享记忆）**：使用固定全局命名空间 `codebuddy:global`。
- **项目级安装（按项目隔离记忆）**：使用 `codebuddy:proj:<workspace-hash>`，其中 hash 由工作区绝对路径稳定派生。

安装时由 `install-codebuddy-skill.sh` 写入 `scripts/.session-scope`（内容为最终 session_key），客户端会自动读取。也可在调用时用 `--session <key>` 显式覆盖。

### Gateway 端点（由 memory-client.mjs 封装，无需手写 HTTP）

- `POST /recall` `{query, session_key}` → `{context, strategy, memory_count}`
- `POST /capture` `{user_content, assistant_content, session_key, session_id?}` → `{l0_recorded, scheduler_notified}`
- `POST /search/memories` `{query, limit?, type?, scene?}`
- `POST /search/conversations` `{query, limit?, session_key?}`
- `GET /health`

默认地址 `http://127.0.0.1:8420`；若 Gateway 启用了鉴权，需通过 `--api-key`（或环境变量 `TDAI_GATEWAY_API_KEY`）传 Bearer token。

## 标准工作流（全自动语义驱动）

CodeBuddy 没有 `agent_end` / `before_prompt_build` 钩子，记忆的召回与捕获改由以下指令驱动 Agent 行为。**所有命令都在 Skill 的 `scripts/` 目录下执行。**

### 步骤 0：确保 Gateway 在线（每个会话仅需一次）

会话内首次涉及记忆时，先确保 Gateway 可用（幂等，可重复调用）：

```bash
bash scripts/gateway-up.sh
```

- 已有实例 → 直接复用；无实例 → 自动拉起并做健康检查。
- 若返回非 0（启动失败），跳过记忆步骤、正常回答，并提示用户查看 `references/troubleshooting.md`。

### 步骤 1：回答前自动召回（recall）

在生成回答**之前**执行（短超时，失败静默降级，绝不阻塞回答）：

```bash
node scripts/memory-client.mjs recall --query "<用户本轮问题>" --timeout 3000
```

- 有输出 → 把返回的记忆上下文作为背景知识融入本轮回答（不要原文复述，自然引用即可）。
- 无输出 / 超时 / 失败 → 直接正常回答，不向用户暴露错误。

### 步骤 2：回答后自动捕获（capture）

在回答**之后**执行（可容忍较长耗时）：

```bash
node scripts/memory-client.mjs capture --user "<用户本轮原话>" --assistant "<本轮最终回答>"
```

- `--user` / `--assistant` 传本轮实际文本。
- 失败不影响用户，记录到 stderr 即可。

### 步骤 3：按需检索（仅用户明确要求时）

```bash
# 检索结构化记忆（L1）
node scripts/memory-client.mjs search-memories --query "<关键词>" --limit 5
# 检索历史原始会话（L0）
node scripts/memory-client.mjs search-conversations --query "<关键词>" --limit 5
```

## 首次安装

若 Gateway 依赖未配置（health 为 down / degraded、或 recall 持续为空），引导用户运行安装脚本：

```bash
# 用户级（跨项目共享记忆）
bash scripts/install-codebuddy-skill.sh --user
# 或项目级（按项目隔离记忆）
bash scripts/install-codebuddy-skill.sh --project
```

安装脚本会：拷贝/软链 Skill 到对应 skills 目录、引导写入 PostgreSQL / LLM / Embedding 配置、设定 session_key 范围。详见 `references/configuration.md`。

## 安全约束

- 绝不在回答或日志中明文回显 PG 口令、API key、Bearer token。
- 配置文件以 0600 权限写入；密钥优先用环境变量注入。
- recall/capture 失败一律静默降级，不向用户暴露内部错误细节与堆栈。

## 完成定义

- `scripts/gateway-up.sh` 健康检查通过。
- 回答前能 recall、回答后能 capture（或在依赖缺失时优雅跳过且不影响回答）。
- 用户的偏好/约定能在后续会话被召回。

## 参考资料

- `references/configuration.md` — PG/LLM/Embedding 配置、扩展依赖、用户级/项目级差异。
- `references/troubleshooting.md` — Gateway 未起、召回为空、扩展缺失、鉴权 401、端口占用等排查。
- `README.md` — 总览、安装与卸载、与 Hermes/OpenClaw 形态的关系。
