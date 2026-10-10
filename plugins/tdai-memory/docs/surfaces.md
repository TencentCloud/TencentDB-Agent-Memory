# Surface compatibility

## Codex in the ChatGPT desktop app and Codex CLI

These surfaces can load Plugins. The bundled `.mcp.json` starts only the local launcher, which in turn starts the official `memory-tencentdb-mcp` executable. The launcher passes through stdio and environment variables unchanged and contains no MCP protocol handling.

Plugin-capable Codex hosts receive three coordinated surfaces: the Skill, the
focused MCP server, and the four Codex lifecycle hooks. Hooks automatically
recall on `UserPromptSubmit` and capture the pending prompt plus
`last_assistant_message` on `Stop`; the MCP server remains independently usable
when hooks are disabled. Hook failures are fail-open.

This is not model-provider proxying. The plugin delegates transport and business
logic to the shared MemoryCore Gateway/Core.

## Codex IDE extension

The IDE extension is documented conservatively. This PR does not claim Plugin
loading, a `codex` agent kind, or transparent IDE injection. TencentDB v2.0.1's
Roadmap/#833 remain the separate MemoryProxy transport route.

## ChatGPT Chat and Work

The universal Plugin model can package compatible Skills and registered MCP
connections across ChatGPT and Codex, but a local stdio command is not a hosted
Work integration. ChatGPT does not execute Codex lifecycle hooks. A real Work
path requires:

1. an official TencentDB MCP service reachable from ChatGPT;
2. registration in ChatGPT developer mode;
3. the returned `plugin_asdk_app...` technical ID in `.app.json`;
4. authentication, privacy, and deployment review.

This repository cannot invent that registration ID or service. Until it exists, the Skill text can travel, while TencentDB tool access remains local to Codex hosts.

## MemoryProxy health

The health check probes MemoryProxy only as an operator convenience. Proxy availability is not treated as proof of Codex support: current v2 code has no `codex` `AgentKind`, and the Roadmap limits the planned adapter to IDE Plan mode.
