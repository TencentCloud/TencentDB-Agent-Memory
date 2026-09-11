# tdai-memory-agent-sdk

TypeScript adapter for using TencentDB Agent Memory from agent SDK based apps.

This package wraps an agent SDK client/session with:

1. Gateway startup and health checks.
2. Pre-turn memory recall.
3. Prompt injection.
4. Streaming pass-through from the underlying SDK.
5. Post-turn capture.
6. Session flush.

It does not use MCP, hooks, or platform plugins. This package is for
applications that already run Codex SDK or Claude Code Agent SDK directly.

The recommended API is a thin wrapper around the SDK object you already use.
The lower-level `createMemoryAgent()` API remains available for tests and for
integrating additional agent SDKs.

## Default Runtime Layout

Each SDK gets isolated Memory data by default:

```text
~/.tdai-memory/codex-sdk/
  tdai-gateway.yaml
  data/
  logs/
  runtime/

~/.tdai-memory/claude-code-sdk/
  tdai-gateway.yaml
  data/
  logs/
  runtime/
```

Codex SDK uses `http://127.0.0.1:8420` by default.
Claude Code Agent SDK uses `http://127.0.0.1:8421` by default.

Pass `gatewayOptions.dataDir` when the two SDKs should share the same Memory
store.

## Codex SDK

```ts
import {
  withCodexMemory,
} from "@tencentdb-agent-memory/tdai-memory-agent-sdk";
import { Codex } from "@openai/codex-sdk";

const codex = new Codex();
const memoryCodex = withCodexMemory(codex, {
  sessionKey: "my-app:session-1",
  userId: "alice",
});

const thread = await memoryCodex.startThread({ model: "gpt-5-codex" });

for await (const event of thread.runStreamed("What should I work on next?")) {
  // Raw Codex SDK events are preserved.
  console.log(event);
}

await thread.endMemorySession();
await memoryCodex.close();
```

`withCodexMemory()` passes through non-conversation client and thread methods.
Use `memoryCodex.unwrap()` or `thread.unwrap()` when the raw SDK object is
needed.

## Claude Code Agent SDK

```ts
import {
  withClaudeCodeMemory,
} from "@tencentdb-agent-memory/tdai-memory-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";

const memoryClaude = withClaudeCodeMemory({ query }, {
  sessionKey: "my-app:session-1",
  userId: "alice",
});

for await (const event of memoryClaude.query({
  prompt: "Reply with exactly: TDAI_AGENT_SDK_OK",
})) {
  // Raw Claude Code Agent SDK messages are preserved.
  console.log(event);
}

await memoryClaude.endMemorySession();
await memoryClaude.close();
```

`withClaudeCodeMemory()` preserves the raw streaming `query()` shape. Use
`memoryClaude.unwrap()` when the raw query function is needed.

## Lower-Level Driver API

Use this when you want a provider-neutral session abstraction:

```ts
import {
  createCodexDriver,
  createMemoryAgent,
} from "@tencentdb-agent-memory/tdai-memory-agent-sdk";

const agent = createMemoryAgent({
  agentSdkName: "codex-sdk",
  driver: createCodexDriver(),
  sessionKey: "my-app:session-1",
  userId: "alice",
});

const session = await agent.startSession();
const result = await session.run({ prompt: "What should I work on next?" });
console.log(result.text);

await session.end();
await agent.close();
```

## Gateway Defaults

The SDK creates `tdai-gateway.yaml` if it does not exist. Existing configs are
not overwritten. If an existing config has a mismatched `server.port` or
`data.baseDir`, startup fails with an actionable error.

Generated configs use local Ollama by default:

- LLM: `gemma4:latest`
- Embedding: `bge-m3:latest`
- Embedding dimensions: `1024`
- `sendDimensions: false`

## Failure Mode

Memory calls are fail-open by default. If recall or capture fails, the agent
continues and emits a `memory.error` stream event.

Set `strict: true` to throw instead.

## Tests

Unit tests:

```bash
npm test -- packages/tdai-memory-agent-sdk
```

Package typecheck:

```bash
cd packages/tdai-memory-agent-sdk
npm run typecheck
```

Real Gateway and SDK E2E tests are gated:

```bash
TDAI_AGENT_SDK_E2E=1 npm run test -- --config vitest.e2e.config.ts
TDAI_AGENT_SDK_E2E=1 TDAI_AGENT_SDK_REAL_CODEX=1 npm run test -- --config vitest.e2e.config.ts
TDAI_AGENT_SDK_E2E=1 TDAI_AGENT_SDK_REAL_CLAUDE_CODE=1 npm run test -- --config vitest.e2e.config.ts
```

Real SDK E2E checks only stable foreground behavior: the SDK call succeeds and
the Gateway records L0 conversation rows. L1/L2/L3 extraction is asynchronous
and model-dependent, so tests do not rely on it being immediately available.

The Claude Code Agent SDK E2E requires the local Claude Code runtime to be
logged in before running the test.
