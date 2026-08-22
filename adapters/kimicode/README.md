# TencentDB Agent Memory adapter for Kimi Code CLI

This directory documents the configuration-only integration between [Kimi Code CLI](https://github.com/MoonshotAI/kimi-cli) and TencentDB Agent Memory through the MemoryProxy OpenAI-compatible endpoint.

Kimi Code CLI supports custom providers using the OpenAI Chat Completions protocol (`openai_legacy`). No Kimi Code source changes or plugin are required.

## Configuration

Edit `~/.kimi/config.toml`:

```toml
[providers.tencentdb-memory]
type = "openai_legacy"
base_url = "http://127.0.0.1:8096/codebuddy/default"
api_key = "sk-tdai-replace-me"
custom_headers = { "x-team-id" = "team-replace-me", "x-agent-id" = "agent-replace-me", "x-task-id" = "task-replace-me", "x-conversation-id" = "conversation-replace-me" }

[models.deepseek-v4-flash]
provider = "tencentdb-memory"
model = "deepseek-v4-flash"
capabilities = ["thinking"]
```

Replace the placeholder with a TencentDB user key locally, or use the Kimi Code credential mechanism supported by your installation. Do not commit a real key. The upstream model API key remains on the MemoryProxy host and is never committed to this file.

The `default` path segment is the MemoryProxy memory instance/space ID used by the local deployment. Use the instance ID from your deployment in other environments.

The model ID must match the model configured by MemoryProxy (`PROXY_UPSTREAM_MODEL`). The proxy route is OpenAI-compatible; the route name is retained for compatibility with the current MemoryProxy route table. If a dedicated `/kimicode/<spaceId>` route is added upstream, only `base_url` needs to change.

The `custom_headers` follow TencentDB's generic OpenAI-client convention used by integrations such as Hermes and OpenClaw:

- `x-team-id`: Team ID;
- `x-agent-id`: Agent ID;
- `x-task-id`: Task ID (required by the current Proxy version);
- `x-conversation-id`: the current conversation identifier. Generate a new value for a new conversation and keep it stable when resuming one.

These values should be injected per workspace/session rather than hard-coded as one global task. The current Kimi Code release does not automatically translate its internal session ID into TencentDB headers, so this adapter uses the same explicit-header approach as the generic Hermes/OpenClaw integrations.

## What this provides

After the first request, MemoryProxy can perform its normal session initialization and bind the Kimi Code session to a Team, Agent, and optional Task. Subsequent turns can receive the bound memory context, and completed turns are written back to MemoryCore according to the proxy extraction configuration.

This adapter is configuration-only. It does not modify Kimi Code, TencentDB Core, or MemoryProxy.

## Limitations

- This integration requires a running TencentDB MemoryProxy and MemoryCore Gateway.
- Kimi Code must send OpenAI Chat Completions requests through the configured provider.
- The model name must be identical on the Kimi Code and MemoryProxy sides.
- Kimi Code does not currently forward its internal session ID automatically; `custom_headers.x-conversation-id` is required.
- Kimi Code CLI's platform-specific search/fetch services are not provided by the TencentDB upstream; use Kimi Code's local fallback or configure those services separately.
- This directory does not duplicate the shared MCP/Gateway client implementation from the existing Kimi Code MCP adapter.

## Verification

1. Start MemoryCore and MemoryProxy.
2. Create or select a TencentDB user key with access to at least one Team and Agent.
3. Set the TencentDB user key and the Team/Agent/Task IDs in `custom_headers`, generating a unique `x-conversation-id` for the current session.
4. Start Kimi Code CLI and send a prompt, confirming the streamed answer.
5. Verify the turn in MemoryCore Chat Memory.
6. For a new session, change only `x-conversation-id`; when switching tasks, update the Team/Agent/Task headers as well.

## Local verification results

The integration was verified end-to-end in a local Windows environment:

| Check | Result |
|---|---|
| Kimi Code configuration parsing | Passed (`kimi doctor config`) |
| `openai_legacy` request construction | Passed |
| MemoryProxy OpenAI-compatible route | Passed (HTTP 200) |
| DeepSeek upstream forwarding | Passed (test response returned) |
| TencentDB session initialization | Passed |
| Team/Agent/Task binding | Passed (`default-team` / Kimi Code / Memory Write Test) |
| TencentDB L0 write-back | Passed (`tdai-recorder:write-l0`) |

The example TOML was validated with Python `tomllib`. No API keys, user keys, or local deployment files are included in this repository.

## 中文说明

本适配通过 Kimi Code CLI 官方支持的 `openai_legacy` 自定义 Provider，将请求发送到 TencentDB MemoryProxy。用户只需配置 `base_url` 和 TencentDB 用户 Key，不需要修改 Kimi Code 源码或安装插件。详细中文说明见 [README_CN.md](./README_CN.md)。
