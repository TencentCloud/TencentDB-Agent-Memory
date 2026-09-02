import {
  withClaudeCodeMemory,
} from "../src/index.js";
import { query } from "@anthropic-ai/claude-agent-sdk";

const memoryClaude = withClaudeCodeMemory({ query }, {
  sessionKey: "example:claude-code-sdk",
  userId: "example-user",
});

try {
  for await (const event of memoryClaude.query({ prompt: "Reply with exactly: TDAI_AGENT_SDK_OK" })) {
    console.log(event);
  }
  await memoryClaude.endMemorySession();
} finally {
  await memoryClaude.close();
}
