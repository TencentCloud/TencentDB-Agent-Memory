# OpenClaw / DSH 接入调研与 OV 结论（TRACK 02）

> 调研结论以源码为准（MemoryProxy/src/agent-adapters/* + MemoryCore
> openclaw-plugin / hermes-plugin），文档仅记录结论与使用方式。

## 1. 结论速览

| 客户端 | 形态 | 本仓库接入点 | 结论 |
|---|---|---|---|
| OpenClaw | OpenAI Chat Completions + Gateway | `agent-adapters/openclaw.ts` + `MemoryCore/openclaw-plugin`（仓库已有原生插件源码） | 可接入：header 预选身份，无需表单 |
| DSH（deepseek-harness） | OpenAI Chat Completions + SSE，带 compact/title 信号 | `agent-adapters/dsh.ts` + `session/dsh/form.ts`（**基线已有，本 PR 未改动**） | 已接入（基线）：adapter 负责 aux 判定 |
| OV（OpenViking 等开源 agent） | 形态未在仓库源码中出现 | 无 | 暂不写适配器，等接口稳定再评估 |

## 2. OpenClaw

### 调用模型

```text
OpenClaw runtime
  models.providers.<name>
    api: openai-completions
    headers: x-team-id / x-agent-id / x-task-id / x-conversation-id
        ▼
  POST /chat/completions + SSE
        ▼
  tdai-proxy /openclaw/{spaceId}/v1/chat/completions
```

### 适配点

- `classifyRequest` → 恒 `main`：未发现 OpenClaw compaction/aux 的独立
  header 或 body 指纹；
- `extractUserText` → content 字符串直接返回，数组走 default 兜底；
- Session Init：`_headerOnlyAgents` 已含 `openclaw`，缺会话 ID 不弹表单。

仓库 `MemoryCore/openclaw-plugin/` 已提供原生工具（memory_search /
conversation_search / read_cos）与 hooks（capture/recall）；Proxy 侧 adapter
负责记忆注入入口的请求分类，两者职责不重叠。

## 3. DSH

### 调用模型

```text
deepseek-harness
  OPENAI_BASE_URL=http://<proxy>:8096/dsh/<spaceId>
        ▼
  POST /chat/completions（带 x-deepseek-harness-* headers）
        ▼
  tdai-proxy /dsh/{spaceId}/chat/completions
```

### 三类请求

| 类别 | 信号 | adapter 返回 |
|---|---|---|
| compaction | `x-deepseek-harness-compact: 1` | auxiliary |
| title-gen | body 三合一（无 tools + thinking.disabled + max_tokens≤128 + title prompt） | auxiliary |
| main | 其它 | main |

DSH 的交互式入口是原生 `ask_user_question` 工具；headless 场景
（无该工具）由 handler 判定后直接透传，避免塞 fake tool 导致客户端报错。

## 4. OV（OpenViking 等）调研结论

仓库与本地工作区目前没有 OV 的源码或运行实例，无法验证其真实请求形状，
因此不写“看起来像但没实证”的 adapter。

可落地结论：

1. 等拿到 OV 真实请求（抓包 / 官方 provider 文档）后再判断协议族；
2. 若同为 OpenAI Chat Completions，按 opencode 模式加一个 adapter +
   契约测试即可，不动注入管线；
3. 在拿到实证前，不接入（避免和 dsh compact 误判一样的问题靠猜）。

## 5. 验证

分两层，避免把"跑过的"和"预期看到的"混在一起：

**5.1 单测（本仓库内可复现，随时可跑）**

```bash
cd MemoryProxy
npm test -- src/__tests__/agent-adapters-openclaw-dsh.test.ts
# 预期：1 个文件 / 9 例通过（契约级：注册表分发、openclaw 恒 main、dsh compact/title 判定、文本提取）
```

**5.2 真机端到端冒烟（步骤可复现；观察结论记录在 PR 描述里，本文档不复述未留存的日志）**

前提：本机已装 openclaw / dsh CLI，且 MemoryProxy 指向真实上游。

```bash
openclaw agent --agent main --message "你好" --model memory-proxy/<模型>
dsh 对话（带 user-agent: deepseek-harness/* 与团队 header）
```

观察点（用于判断接线是否真的生效）：

- 日志 `agentSource=openclaw|dsh`、`kind=main`；
- Session Init 走 header 预选（`preset hit … → register directly`），不弹表单；
- 注入管线 `hookCount>0 / errorCount=0`；
- L0 写入 + `audit.memory-access` 各一条。

## 6. 风险与对策

| 风险 | 触发条件 | 对策 |
|---|---|---|
| OpenClaw 把 compaction / context-pruning 请求也打到同一 provider | 上游出现 aux 类请求 | 当前 `classifyRequest` 恒 `main`，代价是多一次注入（不破坏链路）；拿到真实 aux 指纹后按 dsh 的 `x-deepseek-harness-compact` 模式补判据 |
| OpenClaw 未来把 `content` 从 string 改成 content-block 数组 | 客户端升级 | `extractUserText` 对非 string 走 `defaultAdapter` 兜底拼接；契约测试会先红 |
| DSH 的 title-gen 判据（无 tools + thinking.disabled + max_tokens≤128 + title prompt 四合一）随上游改动漂移 | deepseek-harness 改标题生成策略 | 契约测试 9 例覆盖；新增指纹时先补样例再加判据 |
| OV 形态未知，过早适配反而引入误判 | 拿到 OV 真实请求前 | 不写"看起来像"的 adapter；判定路径见 §4 |
