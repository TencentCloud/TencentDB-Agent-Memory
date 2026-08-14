import fs from "node:fs";
import path from "node:path";
import { installL1RolePackages } from "../../src/gateway/l1/l1-role-installer.js";

/** Install the real role contracts with a deterministic fake at the Pi host boundary. */
export function installFakeL1RoleHost(dataDir: string, root: string): string {
  installL1RolePackages({ dataDir });
  const binary = path.join(root, "fake-pi.mjs");
  fs.writeFileSync(binary, FAKE_PI, { mode: 0o755 });
  fs.chmodSync(binary, 0o755);
  return binary;
}

const FAKE_PI = `#!/usr/bin/env node
const args = process.argv.slice(2);
const promptIndex = args.indexOf("--system-prompt");
const promptPath = promptIndex < 0 ? "" : args[promptIndex + 1];
const input = JSON.parse(args.at(-1));
if (String(promptPath).includes("critic-")) {
  process.stdout.write(JSON.stringify({
    verdict: "approve",
    candidateDigest: input.candidateDigest,
    inputDigest: input.inputDigest,
    reasons: [],
  }));
} else {
  const workset = input.workset ?? input;
  const source = workset.messages.find((message) => message.role === "user") ?? workset.messages[0];
  process.stdout.write(JSON.stringify({
    version: 1,
    assignmentId: workset.assignmentId,
    inputDigest: workset.inputDigest,
    scenes: [{
      name: "Consumer note",
      messageIds: workset.messages.map((message) => message.id),
      memories: [{
        candidateId: "consumer-note",
        content: source.content,
        type: "episodic",
        scope: workset.projectId ? "project" : "global",
        priority: 60,
        sourceMessageIds: [source.id],
        metadata: {},
        action: "store",
        targetIds: [],
      }],
    }],
  }));
}
`;
