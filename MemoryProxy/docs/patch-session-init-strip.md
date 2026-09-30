# Patch: strip session-init form artifacts before forwarding

## 问题

Claude Code 通过 MemoryProxy 使用 DeepSeek 的 Anthropic 兼容端点（extended thinking 模式）时，
每个新会话的 session-init 表单交互结束后，后续请求报 400：

```
The `content[].thinking` in the thinking mode must be passed back to the API.
```

## 根因

sessionInit 为了让 Claude Code 弹出选 team/agent 的 `AskUserQuestion` 表单，会合成一条
带 `toolu_cc_session_init_` 前缀 tool_use 的假响应（无 thinking 块）。客户端回传
tool_result 后，这些合成消息被保留在对话历史里并转发给上游。DeepSeek 的 Anthropic
兼容端点在 extended-thinking 模式下要求**每个 assistant tool_use 必须带真实签名的
thinking 块**，合成消息无有效签名 → 400。

对应上游官方 issue / PR：
- https://github.com/TencentCloud/TencentDB-Agent-Memory/pull/963 (Open，未合并)

## 修复

在 `MemoryProxy/src/anthropicHandler.ts` 新增 `stripSessionInitArtifacts()`，并在转发
边界（`buildUpstreamBody` 与 retry 路径）挂接：

- assistant 消息中含 `toolu_cc_session_init_` tool_use → 整条丢弃
- user/tool 消息中引用 session-init id 的 tool_result 块 → 移除（真实文本块保留）
- 其余消息原样通过（identity），真实对话不受影响

## 验证

- 单测：`stripSessionInitArtifacts` 对表单残留剥离 2 条，对真实对话 0 条
- 端到端：`msgs=6, stream=true`（含表单残留 + thinking mode）转发到 DeepSeek 返回 200
- 回归：无表单残留的普通对话正常

## 备注

- 本补丁同时需要 `form.ts` 已导出 `isSessionInitToolCallId`（镜像内自带）
- 宿主机分支 `feat/server_team` 比发布镜像 `agentmemory/memory-proxy:latest` 新
  （含 request-prepare-adapter 重构、codex/workbuddy/dsh 模块），重建镜像时会一并包含
