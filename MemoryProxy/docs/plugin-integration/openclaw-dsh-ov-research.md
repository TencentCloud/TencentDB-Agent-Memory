# OpenClaw / DSH 接入调研与 OV 结论（TRACK 02）

> 调研结论以源码为准（MemoryProxy/src/agent-adapters/* + MemoryCore
> openclaw-plugin / hermes-plugin），文档仅记录结论与使用方式。

## 1. 结论速览

| 客户端 | 形态 | 本仓库接入点 | 结论 |
|---|---|---|---|
| OpenClaw | OpenAI Chat Completions + Gateway | `agent-adapters/openclaw.ts` + `MemoryCore/openclaw-plugin`（仓库已有原生插件源码） | 可接入：header 预选身份，无需表单 |
| DSH（deepseek-harness） | OpenAI Chat Completions + SSE，带 compact/title 信号 | `agent-adapters/dsh.ts` + `session/dsh/form.ts` | 已接入：adapter 负责 aux 判定 |
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

```bash
cd MemoryProxy
npm test -- src/__tests__/agent-adapters-openclaw-dsh.test.ts
```

真机冒烟（本机已装 openclaw / dsh CLI）：

```bash
openclaw agent --agent main --message "你好" --model memory-proxy/<模型>
dsh 对话（带 user-agent: deepseek-harness/* 与团队 header）
```

预期：日志出现 `agentSource=openclaw|dsh`，Session Init header 预选命中，
注入管线 hook 正常执行，主对话走 main 链路。
