# Codex MCP Integration

This directory contains a portable Codex integration for TencentDB Agent Memory.
It runs TencentDB Agent Memory Gateway locally and exposes memory tools to Codex
through a stdio MCP server.

## Contents

- `AGENTS.md`: recommended global Codex operating instructions.
- `DEPLOYMENT.md`: end-to-end setup guide.
- `mcp/tdai-memory/server.py`: Python MCP bridge for Codex.
- `mcp/tdai-memory/requirements.txt`: Python dependencies for the MCP bridge.
- `scripts/start-gateway.sh`: portable Gateway startup script.
- `systemd/tdai-memory-gateway.service.template`: user systemd service template.
- `env/gateway.env.example`: example LLM configuration without secrets.

## Exposed MCP Tools

- `tdai_recall`
- `tdai_memory_search`
- `tdai_conversation_search`
- `tdai_capture`
- `tdai_session_end`

## Quick Agent Prompt

```text
Read integrations/codex/AGENTS.md and integrations/codex/DEPLOYMENT.md.
Install TencentDB Agent Memory Gateway and register the tdai-memory MCP server
with Codex. Install AGENTS.md globally at $CODEX_HOME/AGENTS.md. Use
integrations/codex/env/gateway.env.example as a template, but never record or
expose API keys.
```

## Do Not Distribute

- Real `gateway.env` files.
- API keys, access tokens, or private credentials.
- `$CODEX_HOME/auth.json`.
- Local memory data under `$TDAI_HOME/memory-tdai`.
- `node_modules` or build output.
