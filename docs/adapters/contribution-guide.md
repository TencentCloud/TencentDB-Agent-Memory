# Adapter Contribution Guide

This guide helps contributors keep cross-platform adapter pull requests focused and easy to review. It is especially
useful for issue #235, where several adapter efforts may run in parallel.

## Adapter Lanes

| Lane | Owns | Should avoid |
| :--- | :--- | :--- |
| Shared Gateway client | Typed HTTP client for `/recall`, `/capture`, `/search/*`, `/session/end`, retry/error handling, lifecycle helpers | Platform-specific hooks, CLI processes, MCP protocol details |
| Coding-agent adapter | Codex-style or Claude Code-style lifecycle mapping, session key strategy, prompt injection/capture examples | Reimplementing the shared Gateway HTTP client |
| MCP bridge | MCP server/stdio transport, tool schemas, protocol-level validation, process lifecycle | Duplicating coding-agent lifecycle docs unless needed for MCP examples |
| Dify/workflow adapter | Dify extension points, conversation identity mapping, workflow-specific setup | Generic Gateway SDK code that belongs in the shared client lane |
| Documentation-only PR | Architecture diagrams, comparison tables, verification playbooks, migration notes | Shipping unverified adapter code snippets as if they were production APIs |

## Review Checklist

Before opening or updating an adapter PR:

1. Identify the lane in the PR description.
2. Link the issue or PR that owns any dependency lane.
3. Keep duplicated Gateway request/response types out of platform-specific adapters when a shared client already exists.
4. Include the hook mapping: before-turn recall, after-turn capture, explicit search, and session end/flush.
5. Show how the adapter builds stable `session_key` values from platform identity.
6. Document auth behavior for `TDAI_GATEWAY_API_KEY` when the Gateway is exposed beyond localhost.
7. Add focused tests for request shape, auth headers, error handling, and session identity.
8. Run the project checks that match the changed files, and list them in the PR body.

## Suggested PR Body Note

```md
Adapter lane: <shared Gateway client | coding-agent adapter | MCP bridge | Dify adapter | docs>
Depends on / complements: <PR or issue link>

This PR intentionally does not implement <other lane>, because that scope is covered by <PR or issue link>.
```

Using these lanes keeps adapter work additive: a platform-specific adapter can depend on the shared Gateway client, an
MCP bridge can expose the same capabilities through protocol tooling, and documentation can clarify integration without
creating another competing implementation.
