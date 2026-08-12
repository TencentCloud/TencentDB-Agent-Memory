# CodeBuddy CLI 接入指南

> 本文档面向 **fork 开发者**：官方仓库 `TencentCloud/TencentDB-Agent-Memory` 只支持
> **CodeBuddy IDE**（其交互工具名为 `ask_followup_question`）；本 fork 新增了
> **CodeBuddy CLI**（`@tencent-ai/codebuddy-code`）支持，交互工具名为 `AskUserQuestion`。
> 两者协议不同，本文只讲 CLI。
>
> 前置条件：三件套（memory-core / memory-hub / proxy）已通过
> [`deploy/global-images/README.md`](../deploy/global-images/README.md) 部署并运行。
> 本文不重复部署内容，只讲 CLI 接入。

---

## 1. 整体链路

```text
CodeBuddy CLI（@tencent-ai/codebuddy-code）
        │  CODEBUDDY_BASE_URL=http://127.0.0.1:8096/codebuddy/default
        │  CODEBUDDY_API_KEY=<内核有效 user_key>
        ▼
   MemoryProxy :8096（tdai-proxy 容器）
        │  1. auth      —— 用请求的 API key 调内核 /v3/meta/auth/verify → user_id
        │  2. sessionInit —— 首轮弹 AskUserQuestion 表单：Team → Agent → Task
        │  3. injection —— 注入 skill / knowledge / memory 到 system prompt
        ▼
   上游 LLM（DeepSeek / OpenAI-compatible）
```

关键点：**CLI 走 OpenAI 协议**（`/codebuddy/<spaceId>/v1/chat/completions`），不是 Claude Code
的 Anthropic 协议。因此 proxy 必须配置 `upstream.agents.codebuddy.url` 指向 OpenAI 兼容端点
（不能是 `/anthropic`）。

## 2. 部署交接点（.env）

三件套拉起后，确认 `deploy/global-images/.env` 已开启这两个开关（`start-proxy.sh`
启动时写入挂载的 config.yaml）：

```bash
PROXY_ENABLE_SESSION_INIT=1   # 首轮弹表单选 team/agent/task
PROXY_ENABLE_AUTH=1           # 用请求凭据解析真实 user_id（sessionInit 的前置依赖）
```

> `start-proxy.sh` 会校验依赖：开 sessionInit 时若 auth 未开会自动补开，并打印
> `(auth=true session-init=true)`。改完 `.env` 需重跑 `./start-proxy.sh` 重建容器生效。

## 3. 镜像补丁（fork 特有，必须）

当前 `agentmemory/memory-proxy:latest` 镜像**不含**本 fork 的 CLI 适配代码（仍是
`ask_followup_question` 旧工具名）。直接用最新代码打补丁：

```bash
cd deploy/global-images

# 1) AskUserQuestion 表单兼容：form.ts + extractor.ts 同步进容器
bash patch-codebuddy-form.sh

# 2) OpenAI 协议 thinking 兼容：handler.ts + reasoning/* 同步进容器
bash patch-proxy-thinking-openai.sh
```

每个脚本有幂等检测（检测到已含 `AskUserQuestion` / 补丁已生效即跳过），
会 `docker cp` 源码进容器并重启。**容器重建后补丁丢失**，需要重跑。

> 说明：OpenAI thinking 补丁同步 `handler.ts`（回填写回 `upstreamBody`）、
> `reasoning/adapter.ts` + `reasoning/openai-forward.ts`（模型匹配规则）。
> DeepSeek thinking 家族模型（reasoner / r1 / **v4\* 如 deepseek-v4-flash** /
> think 字样）在 tool_calls 历史消息缺 `reasoning_content` 时补空串回传；
> 其它 provider 不做任何注入。

> 验证补丁已生效：
> ```bash
> docker exec tdai-proxy sh -c 'grep -n "TOOL_NAME" /app/src/session/codebuddy/form.ts'
> # 应输出：export const TOOL_NAME = "AskUserQuestion";
> ```

## 4. CLI 配置（核心）

CodeBuddy CLI 通过 `~/.codebuddy/settings.json` 的 `env` 段配置：

```jsonc
{
  "model": "deepseek-v4-flash",
  "env": {
    "CODEBUDDY_BASE_URL": "http://127.0.0.1:8096/codebuddy/default",
    "CODEBUDDY_API_KEY": "sk-mem-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "CODEBUDDY_MODEL": "deepseek-v4-flash",
    "CODEBUDDY_SMALL_FAST_MODEL": "deepseek-v4-flash",
    "CODEBUDDY_BIG_SLOW_MODEL": "deepseek-v4-flash",
    "CODEBUDDY_CODE_SUBAGENT_MODEL": "deepseek-v4-flash"
  }
}
```

| 变量 | 值 | 说明 |
| --- | --- | --- |
| `CODEBUDDY_BASE_URL` | `http://127.0.0.1:8096/codebuddy/default` | 指向 proxy 的 CodeBuddy 路由，`default` 是 spaceId |
| `CODEBUDDY_API_KEY` | 内核**有效** user_key | **必须**是 MemoryCore 里注册过的 user_key（见下） |
| `CODEBUDDY_MODEL` | 与 proxy 上游一致的模型名 | 需命中 proxy 定价表，否则 400 |
| `CODEBUDDY_SMALL_FAST_MODEL` / `CODEBUDDY_BIG_SLOW_MODEL` | 同主模型 | 覆盖 lite / reasoning 变体 |
| `CODEBUDDY_CODE_SUBAGENT_MODEL` | 同主模型 | 统一覆盖子代理模型 |

### API key 必须是内核有效 user_key

弹窗要列出 team/agent/task，代理会拿 CLI 请求的 API key 调内核
`/v3/meta/auth/verify`，**用解析出的 `user_id` 去查 team/agent 列表**。

- 无效 key → `verify` 返回 `valid:false` → 身份回落为 CLI 匿名标识
  （如 `anonymous_ad2G6wHy`）→ 内核查不到任何 team → **弹窗静默跳过**
- 有效 key 怎么来：首次部署时 `start-memory-core.sh` 会 `init-admin` 生成 system_admin
  用户，其 user_key 持久化在 `deploy/global-images/.admin-key`。把它填进
  `CODEBUDDY_API_KEY` 即可（或用 Panel 给该用户配的 key）。

验证 key 是否有效：

```bash
ADMIN_KEY=$(cat deploy/global-images/.admin-key)
curl -s -X POST http://127.0.0.1:8420/v3/meta/auth/verify \
  -H "content-type: application/json" -H "x-tdai-service-id: default" \
  -d "{\"user_key\":\"$ADMIN_KEY\"}"
# 期望：{"code":0,...,"data":{"valid":true,"user":{"user_id":"usr-xxx",...}}}
```

## 5. 验证弹窗

改完 settings.json 需**重启 CLI 进程**（env 不会热加载）。

### 方式 A：起新对话，看 CLI 是否弹出表单

新建会话（不要用旧会话 resume），首条消息发出后 CLI 应弹出
`AskUserQuestion` 交互表单：

1. **是否关联团队资产？**（是/否）
2. 选择 **Team**
3. 选择 **Agent** / **Task**

> 注意：已产生过对话历史的会话不会弹（状态机已终态）。只有**全新会话**首轮会弹。

### 方式 B：curl 直接触发

用带新 conversation id 的请求模拟首轮：

```bash
NEW_KEY="sk-mem-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
curl -s -X POST "http://127.0.0.1:8096/codebuddy/default/v1/chat/completions" \
  -H "content-type: application/json" -H "Authorization: Bearer $NEW_KEY" \
  -H "x-conversation-id: test-init-$(date +%s%N)" \
  -d '{"model":"deepseek-v4-flash","stream":false,"messages":[{"role":"user","content":"<user_query>你好</user_query>"}]}'
```

成功时返回带 `AskUserQuestion` tool_call 的响应：

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "tool_calls": [{
        "function": {
          "name": "AskUserQuestion",
          "arguments": "{\"questions\":[{\"question\":\"...是否关联团队资产...\",\"header\":\"关联资产\",\"options\":[...]}]}"
        }
      }]
    }
  }]
}
```

### 看代理日志确认状态机

```bash
docker logs tdai-proxy --since 10m | grep -E "session-init:cb|injection-debug"
```

关键日志（三者都应出现）：

```
[injection-debug] ... userId=usr-xxxxxxxx agentSource=codebuddy sessionInitEnabled=true ...
[session-init:cb] session=... user=usr-xxxxxxxx → pending_asset_confirm (teams=2)
```

- `userId=usr-xxxx`：auth 解析出真实用户（不是 `anonymous_...`）
- `sessionInitEnabled=true`：开关生效
- `pending_asset_confirm (teams=N)`：状态机进入弹窗，N>0 才有内容可选

## 6. 常见问题排查

| 症状 | 根因 | 处理 |
| --- | --- | --- |
| 完全不弹窗，日志 `sessionInitEnabled=false` | config.yaml 里 `sessionInit.enabled: false` | `.env` 设 `PROXY_ENABLE_SESSION_INIT=1`，重跑 `start-proxy.sh` |
| 弹窗查不到 team，日志 `userId=anonymous_xxx` | auth 未开或 API key 无效，身份回落匿名 | 开 `PROXY_ENABLE_AUTH=1`；确认 `CODEBUDDY_API_KEY` 是内核有效 user_key |
| 弹窗查不到 team，日志 `team/list HTTP 401 invalid_user_key` | CLI 请求的 key 内核不认识 | 换 `.admin-key` 里的有效 key |
| 弹窗没弹但表单工具报错（旧版本日志） | 镜像还是 `ask_followup_question` 旧代码 | 重跑 `patch-codebuddy-form.sh` |
| 容器重建后弹窗又失效 | 补丁随容器丢失 | 重跑两个 patch 脚本 |
| 请求返回 400 `model_not_found` | CLI 的 model 未命中 proxy 定价表 | 对齐 `CODEBUDDY_MODEL` 与 proxy 配置的上游模型名 |

### 排查顺序建议

```
1. docker logs tdai-proxy | grep "injection-debug"
   → 看 sessionInitEnabled / userId
2. 确认 userId 是 usr-xxx 而非 anonymous_xxx
   → 不是则查 auth + API key
3. curl 内核 /v3/meta/auth/verify 验证 key
4. curl 触发弹窗（方式 B）确认返回 AskUserQuestion
```

## 7. 相关代码位置

| 能力 | 文件 |
| --- | --- |
| CodeBuddy 会话初始化状态机 | `MemoryProxy/src/session/codebuddy/init.ts` |
| AskUserQuestion 表单构造 | `MemoryProxy/src/session/codebuddy/form.ts` |
| 表单回写解析（JSON / XML 双格式） | `MemoryProxy/src/session/codebuddy/extractor.ts` |
| CodeBuddy 适配器（协议/身份识别） | `MemoryProxy/src/agent-adapters/codebuddy.ts` |
| 镜像补丁脚本 | `deploy/global-images/patch-codebuddy-form.sh` |
| OpenAI thinking 补丁脚本 | `deploy/global-images/patch-proxy-thinking-openai.sh` |
