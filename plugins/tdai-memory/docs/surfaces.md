# Surface compatibility

## Codex in the ChatGPT desktop app and Codex CLI

These surfaces can load Plugins. The bundled `.mcp.json` starts only the local launcher, which in turn starts the official `memory-tencentdb-mcp` executable. The launcher passes through stdio and environment variables unchanged and contains no MCP protocol handling.

This provides an honest fallback for Codex CLI and non-Plan work: the agent can explicitly recall, search, capture, or flush through MCP. It does not provide transparent injection, automatic capture, or model-provider proxying.

## Codex IDE extension

OpenAI's Plugin documentation says the IDE extension does not support Plugins. TencentDB v2.0.1's Roadmap assigns IDE Plan-mode support to MemoryProxy. These are complementary surfaces, so this Plugin never registers a `codex` agent kind or changes Proxy routing.

## ChatGPT Chat and Work

The universal Plugin model can package Skills and registered MCP connections across ChatGPT and Codex, but a local stdio command is not a hosted Work integration. A real Work path requires:

1. an official TencentDB MCP service reachable from ChatGPT;
2. registration in ChatGPT developer mode;
3. the returned `plugin_asdk_app...` technical ID in `.app.json`;
4. authentication, privacy, and deployment review.

This repository cannot invent that registration ID or service. Until it exists, the Skill text can travel, while TencentDB tool access remains local to Codex hosts.

## MemoryProxy health

The health check probes MemoryProxy only as an operator convenience. Proxy availability is not treated as proof of Codex support: current v2 code has no `codex` `AgentKind`, and the Roadmap limits the planned adapter to IDE Plan mode.
