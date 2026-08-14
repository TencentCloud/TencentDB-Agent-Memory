import {
  withCodexMemory,
} from "../src/index.js";
import { Codex } from "@openai/codex-sdk";

const codex = new Codex();
const memoryCodex = withCodexMemory(codex, {
  sessionKey: "example:codex-sdk",
  userId: "example-user",
});

try {
  const thread = await memoryCodex.startThread();
  for await (const event of thread.runStreamed("Reply with exactly: TDAI_AGENT_SDK_OK")) {
    process.stdout.write(JSON.stringify(event));
  }
  await thread.endMemorySession();
} finally {
  await memoryCodex.close();
}
