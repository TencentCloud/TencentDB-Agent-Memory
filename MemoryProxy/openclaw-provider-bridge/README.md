# OpenClaw Memory Proxy Bridge

OpenClaw provider plugin for TencentDB Agent Memory Proxy. It maps each OpenClaw Agent to a Memory Team/Agent and attaches stable identity headers on every model request, including tool-loop continuations. Task selection is optional and session-scoped; OpenClaw's runtime session id becomes the conversation id, so no static `x-conversation-id` is required.

See [README_CN.md](./README_CN.md) for installation and usage, and [docs/architecture_CN.md](./docs/architecture_CN.md) for the architecture.

Quick start:

```bash
export MEMORY_PROXY_URL=http://127.0.0.1:8096
export MEMORY_PROXY_INSTANCE_ID=default
export MEMORY_PROXY_API_KEY=sk-mem-...
export OPENCLAW_AGENT_ID=main
export TDAI_TEAM_ID=team-...
export TDAI_AGENT_ID=agent-...
export MEMORY_PROXY_MODEL_ID=gpt-5.5
bash ../scripts/install-openclaw-provider-bridge.sh
```

Start OpenClaw Gateway (Memory Proxy must already be running independently):

```bash
export MEMORY_PROXY_API_KEY=sk-mem-...
bash ../scripts/start-openclaw-stack.sh
```

The script preserves an existing `gateway.mode`. If it is missing, it sets the mode to `local` through the OpenClaw CLI before startup. Override the initial mode with `OPENCLAW_GATEWAY_MODE`.

The installer also registers the selected model under `models.providers.memory-proxy`, preventing a loaded provider from leaving the model marked as `missing`. The config stores only an environment SecretRef to `MEMORY_PROXY_API_KEY`, not the key value.

`MEMORY_PROXY_MODEL_ID` is OpenClaw's local route name and the `model` value sent to Memory Proxy. It does not make OpenClaw call a model service directly. If Proxy `creditPricing.models` is configured, use its public `modelName`.
