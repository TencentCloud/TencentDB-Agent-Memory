import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordConversation } from "./l0-recorder.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("L0 capture with persisted Recall ledger", () => {
  it("records the cached original user text instead of injected ledger content", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-l0-ledger-"));
    temporaryDirectories.push(baseDir);
    const originalUserText =
      "Please remember that this is the clean original user request.";
    const injectedUserText = `${originalUserText}

<relevant-memories data-ledger-version="1">
<memory-ref id="memory-1" revision="${"a".repeat(64)}">
secret recalled text that must not enter L0
</memory-ref>
</relevant-memories>`;
    const timestamp = Date.now();

    const captured = await recordConversation({
      sessionKey: "agent:main:l0-ledger-test",
      sessionId: "l0-ledger-test",
      baseDir,
      originalUserText,
      originalUserMessageCount: 1,
      rawMessages: [
        { role: "assistant", content: "existing history", timestamp: timestamp - 10 },
        { role: "user", content: injectedUserText, timestamp },
        {
          role: "assistant",
          content: "This assistant response is long enough to be captured.",
          timestamp: timestamp + 1,
        },
      ],
    });

    const user = captured.find((message) => message.role === "user");
    expect(user?.content).toBe(originalUserText);
    expect(JSON.stringify(captured)).not.toContain("secret recalled text");

    const conversationDir = path.join(baseDir, "conversations");
    const files = await fs.readdir(conversationDir);
    const persisted = await fs.readFile(path.join(conversationDir, files[0]), "utf8");
    expect(persisted).toContain(originalUserText);
    expect(persisted).not.toContain("secret recalled text");
  });
});
