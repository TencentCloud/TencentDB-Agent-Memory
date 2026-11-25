# OpenHands

> agentSource: `openhands` | 协议: OpenAI Chat Completions | Session Init: Header 预选（无交互 Form）
>
> 英文版见 [README.md](./README.md)；§8 排障表 / §9 限制与隐私 / §10 文件清单在
> [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)。结构与 [Hermes](../hermes/README.md) 对齐。
>
> OpenHands 经 LiteLLM 发标准 `chat/completions`，可用 `extra_headers` 挂自定义 header；
> 它无法响应 proxy 返回的 form tool call，所以身份只能靠 header 传入。

客户端侧只含文档与示例；proxy 侧另有少量改动，把 OpenHands 归入 header 预选类客户端（§6）。

> 引用约定：`file:line` 锚点基于基线 commit `8b86874`；本 PR 补丁涉及文件内锚点可能漂移，
> 以锚点旁的符号名为准。

---

## 1. 客户端接入配置

```python
from openhands.sdk import LLM

llm = LLM(
    model="openai/<model-id>",                    # LiteLLM provider 前缀
    base_url="http://<proxy-host>:8096/openhands/<spaceId>/v1",
    api_key="sk-mem-<user_key>",
    extra_headers={
        "x-team-id": "<面板里的 team_id>",
        "x-agent-id": "<面板里的 agent_id>",
        "x-task-id": "<面板里的 task_id>",
        "x-conversation-id": "<自定义会话标识>",
    },
)
```

`POST /openhands/:spaceId/v1/chat/completions` 由泛用路由注册（`MemoryProxy/src/server.ts:336`）；
`agentSource` 取自**路径首段**（`MemoryProxy/src/handler.ts:665-667`，仅排除 `v1` / `proxy` /
`skill-bridge` / `memory-bridge`），因此**无需新增路由**。`<spaceId>` 是 memory 实例 ID
（本地单机部署固定 `default`）。

> ⚠️ 不要借用 `/codebuddy/`。`agentSource` 就是首段（`handler.ts:665-667`），借前缀会让
> OpenHands 产生的每个 session、记忆行、credit 记录都被**静默打错标签**。
> `routes/whitelist.ts:175`（`AGENT_PREFIX_RE`）只是剥 spaceId 的辅助正则，**不是** agent 白名单 ——
> 里面本来就没有 `hermes` / `dsh` / `opencode`，它们都已上线且正常，所以 `openhands` 也不必加。
> URL 形状由 `validate.js` 把关。

**取 key。** `/v3/meta/*` 在 proxy 租户鉴权下不给 bootstrap admin key —— 该端点在 **memory-core**
（端口 8420）上，鉴权走 `x-tdai-user-key`。用首次启动打印的 admin key（文件
`deploy/global-images/.admin-key`，切勿提交）为每个业务用户签发一把 key：

```bash
curl -sS -X POST "http://<memory-core-host>:8420/v3/meta/user-key/create" \
  -H "x-tdai-user-key: <admin key>" \
  -H "x-tdai-service-id: <spaceId>" -H "content-type: application/json" \
  -d '{"user_id": "<面板里的 usr-...>", "name": "openhands-user"}'
```

路由见 `MemoryCore/src/metadata/router/v3-meta-router.ts:119`（schema
`v3-meta-schemas.ts:470-474`）。`data.key_value`（`sk-mem-…`）**只返回一次**（2026-10-05 本机实测：
HTTP 200、`code=0`、长度 39、前缀 `sk-mem`）；填进 `api_key`；**不要**提交进仓库，
也**绝对不要**粘贴进被 proxy 转发的对话内容里（§9）。

---

## 2. Session ID

| 来源 | Header |
|------|--------|
| 唯一 | `x-conversation-id`（客户端设置；OpenHands 不代管） |

两处身份解析都把 `x-conversation-id` 排在**第一优先**：`session/session-key.ts:9-19`（对话链路）、
`skill/skill-bridge.ts:234-242`（bridge 链路）。对话链路落库用复合键
`${agentSource}:${sessionId}`（`handler.ts:810,877`）。

**一个 OpenHands 对话用一个 `x-conversation-id`**，开新对话就换新的 —— 复用旧 id 会接着走
上次 session 的状态。

---

## 3. ⚠️ 首轮 header 规则（排障前必读）

Header 预选**只在「该 session 尚未初始化」的那一轮**生效：

- `MemoryProxy/src/session/codebuddy/init.ts:824-825` —
  `if (presetIdentity && config.headerAutoSelect?.enabled) { resolvePresetIdentity(teams, presetIdentity) }`
- `presetIdentity` 在 `handler.ts:874` 从 header 解析；功能默认开（`config.ts:98-104`，装配
  `config.ts:426-431`；`start-proxy.sh:129-134` 生成的配置写死 `headerAutoSelect.enabled: true`）。
- header 值只有命中调用方自己可见的 `teams[]` 才被采信（`session/preset.ts:9-12`）——
  填错是 mismatch，不是越权。

**后果。** 若**第一轮**缺任一 header（或校验失败），session 会停在
`pending_asset_confirm`（`init.ts:1000`）；之后即使带齐 header 也只会进恢复分支
`init.ts:1098+`（Case 1.25），该分支只读表单答案、**永不再调 `resolvePresetIdentity`** ——
OpenHands 没有能回答表单的 UI，session 就此永久卡住、不注入。
`extra_headers` 设在 `LLM` 对象上时 LiteLLM 每轮都会带（含 SDK 内部 summarizer 调用），正常
不会触发；header 若**按调用**逐个传、首个调用（aux 类）漏了，就会触发。

**恢复：** 换新 `x-conversation-id`（回到 Case 1 重新注册），或清 proxy session 存储（§5）。
产品侧修复见 `ISSUE_DRAFT.md`。

---

## 4. 在 OpenHands 里调用 skill / memory bridge

两个 bridge 都是**全局挂载**、不按 agent 区分（`server.ts:134`、`:139`；路径匹配
`skill-bridge.ts:343`），只靠 header 认会话 —— 任何客户端都能直接 curl：

```bash
curl -sS -X POST "http://<proxy-host>:8096/skill-bridge/v3/skill/listing" \
  -H "x-conversation-id: <与对话轮次同一个 id>" \
  -H "x-tdai-service-id: <spaceId>" -H "content-type: application/json" -d '{}'
```

- 没有会话 header → `40101`（`skill-bridge.ts:495-501`；`memory/memory-bridge.ts:303` 同构）。
- 先查内存 session store（`skill-bridge.ts:294-300`），再查持久 binding —— 但 L2 受 `spaceId`
  门控（来自 `x-tdai-service-id`，`:503-506`；门控 `if (!ids && bindingRepoInline && spaceId)`）；
  两空即 `40101`（`:526`；`memory-bridge.ts:322` 同理）。
- **为什么必须带 service-id header：** binding 键是 `(spaceId, sessionId)`，sessionId 为**裸**
  id、不含 agentSource（`db/binding-repo.ts:43-48,54-57`；写入 `session/store.ts:244`）——
  binding 存在时前缀无关紧要；但少了 spaceId，L2 连查都不查。
- skill 写操作（`create`/`update`/`patch`/`delete`/`files/write`/`files/remove`）默认禁止 —— §7。

---

## 5. proxy session 存储持久化

原本 `start-proxy.sh` **只挂**生成的 `config.yaml`（base `:158`），而 store 在镜像内置的
`PROXY_DB_PATH=/data/tdai-memory-proxy/proxy.db`（`MemoryProxy/Dockerfile:84,93`；解析
`db/index.ts:4`、`storage/factory.ts:283-289`）。脚本每次都 `rm_container_if_exists`（base `:44`）
再 `docker run`，容器可写层随之销毁 —— session、binding、限流桶、对话缓冲全清。

本 PR 按兄弟服务写法（`start-memory-core.sh:208`、`start-memory-hub.sh:98`）加 named volume：
`PROXY_VOLUME`（默认 `tdai-proxy-data`）挂 `/data/tdai-memory-proxy`；故意**不**覆盖
`PROXY_DB_PATH`，挂同一目录即可，diff 最小。清 session 用 `docker volume rm tdai-proxy-data`
或 `./stop-all.sh --purge`（本 PR 已把 `PROXY_VOLUME` 加进 purge 删卷循环）。

---

## 6. proxy 侧需要的改动（`agentSource=openhands`）

路由不用改（§1）。但必须声明「无 form UI」这个属性，否则 `mem:session-reset` 会给 OpenHands
弹一个它答不了的表单 —— 那正好触发 §3 的卡死：

```text
MemoryProxy/src/handler.ts:781
  const _headerOnlyAgents = new Set(["hermes", "openclaw", "openhands"]);
```

这个 set 同时做两件事：对无 form 客户端拒绝 `mem:session-reset`（`handler.ts:782-801`）、
跳过交互式 reset 分支（`:802`）；其设立原因（见原注释）正是 hermes / openclaw / dsh-headless
没有 form 可弹、reset 后会永远卡在 `pending_asset_confirm` —— 和 OpenHands 同构。
`credit-reporter.ts:77` 同步补上 `openhands`，否则该路径 auth 直接 401（缺 spaceId）。

刻意**不改**：`routes/whitelist.ts:175`（剥 spaceId 的辅助正则，非白名单）；
`session/client-capabilities.ts`（只特判 workbuddy）；`injection/pipeline.ts:185`（已通用）；
`agent-adapters/types.ts:23`（`AgentKind` 连 hermes / openclaw 都没有 —— 只加 openhands
是不一致的范围蔓延，作为 follow-up）。

---

## 7. 写权限开关（`skillRuntime.allowLlmWrite`）

bridge 写操作默认拒绝：`allowLlmWrite: false`（`config.ts:138`，读取 `:484-486`，执行点
`skill-bridge.ts:533-542` → `40302`；注入侧门控 `injection/index.ts:310-311`）。上游唯一开关是
YAML 键 `skillRuntime.allowLlmWrite: true`（`config.example.yaml:663`）；本 PR 给
`start-proxy.sh` 加了 `.env → YAML` 糖 `PROXY_ALLOW_LLM_WRITE=1`（默认 0；渲染结果
2026-10-05 本机实测：不设→`false`、设 1→`true`。**UNVERIFIED**：开启后 `skill/create`
真正成功 —— pilot 中为生效该开关而重启 proxy，重启洗掉了 session store，下一次调用改判 `40101`；
§5 正是该问题的修复）。

⚠️ 开启等于授权：模型可创建 skill 并注入同团队后续 session，绕过人工评审。按 team/task
最小化开启；配合 §5 持久化后，写权限打开的记忆库同时也是持久化的。

---

## 8. 排障对照

完整英文表在 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) §8；常见四条：

| 现象 | 原因 / 处理 |
|------|-------------|
| bridge `40101 … session not initialized`，对话链路却正常 | L1 前缀未命中且缺 `x-tdai-service-id` 使 L2 被跳过 → bridge 调用固定带该 header（§4）；L1 已补 `hermes:` / `openclaw:` / `openhands:` 候选 |
| 注入始终不出现，像 header 被忽略 | 首轮缺 header 卡在 `pending_asset_confirm`（§3）→ 换 `x-conversation-id` 或清 store（§5） |
| `40302 … write access … disabled` | 写门默认关（§7）→ 显式开启或只用读操作 |
| `mem:session-reset` 回「不支持 openhands」 | 预期（`handler.ts:781-801`）：改三个身份 header + 换 `x-conversation-id` |

免装 OpenHands 的自检：`GET /health`（`server.ts:85-105`）、`GET /whoami` 带
`Authorization: Bearer sk-mem-<user_key>`（`server.ts:108`），或
`python3 example/openhands_connect.py --check`。

---

## 9. 已知限制与隐私/安全

- **`x-conversation-id` 全靠手动**：OpenHands 不代管 proxy 的 session；漏带 header 的轮次
  （部分重试 / auxiliary 路径）不注入。
- **`x-task-id` 当前必填**：缺失即弹 form，而 OpenHands 答不了 → bypass → 注入不生效。
- **`AgentKind` 无 `openhands`**：走 `unknown` 兜底（`agent-adapters/types.ts:23`、
  `agent-adapters/index.ts:28-41`），与 hermes / openclaw 现状一致；注入走通用路径
  （`injection/pipeline.ts:185`）。
- **🔒 凭据会被原样写进原始记忆。** 本地金丝雀实测：凭据形状的字符串一经发进被 proxy 转发的
  对话，就**未经脱敏**落到 L0 采集（`l0_conversations.message_text`，`l0_fts_content` 内可子串
  检索），因此可被召回并重新注入后续 prompt。proxy 自身日志干净；现有脱敏链路**不覆盖**采集路径。
  结论：**凡经 proxy 发出的密钥，一律视为已进入团队记忆。** 红线：key 只走 config / env（§1、§2），
  绝不进对话内容；team / agent 尽量小范围；用 task 白名单而非大范围共享团队。
  **UNVERIFIED upstream** —— 仅本机 v2.0.x 镜像复现。
- **前缀缓存实测（仅作佐证，不是新结论）**：同一段注入内容，走 proxy 的第 2-5 轮
  `cached/prompt ≈ 0.966`，直连同款上游为 `0.000`；复现命令见 `PR_BODY.md`。
  **UNVERIFIED upstream**：单一样本、单一上游（Alibaba compatible-mode）。
- **验证范围**：以上均在一台主机、`agentmemory/memory-proxy` v2.0.x + OpenHands SDK v1.x 上实测。
  **UNVERIFIED**：SDK 版本矩阵、`stream: true` 首轮交互、多租户规模下的行为。

文件清单：`README.md`（英文正文，§1-§7 对应本文）、`TROUBLESHOOTING.md`（英文 §8-§10）、
`openhands.json` + `validate.js`、`example/openhands_connect.py`。
