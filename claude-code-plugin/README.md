# TencentDB Agent Memory for Claude Code

This plugin maps Claude Code lifecycle hooks to the existing TencentDB Agent
Memory Gateway:

- `UserPromptSubmit` recalls relevant memory into `additionalContext`.
- `Stop` captures the prompt and `last_assistant_message` as one turn.
- `SessionEnd` flushes the session pipeline.

The plugin is self-contained: its hooks run the bundled
`scripts/memory-hook.mjs` executable, so marketplace caching never needs to
traverse outside the plugin directory. `npm run build:plugin` refreshes that
bundle when developing the TypeScript source.

See [the complete setup and behavior guide](../docs/claude-code-adapter.md).
