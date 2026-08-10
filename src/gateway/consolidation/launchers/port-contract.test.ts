/**
 * The RoleLauncher CONTRACT, run against every host (tz-06 Ф5b).
 *
 * One suite, three implementations: whatever a launcher does with argv, these
 * promises are the same or the port is a lie. A fourth host added later either
 * passes this table or does not ship.
 *
 * The "binary" is a shell script that ignores its arguments — the point here
 * is the lifecycle, not the flags (those are each launcher's own test).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createPiLauncher } from "./pi.js";
import { createClaudeLauncher } from "./claude.js";
import { createCodexLauncher } from "./codex.js";
import { OUTPUT_TAIL_BYTES } from "./output-spool.js";
import type { ResolvedRoleContract } from "../role-contract-types.js";
import type { LaunchInput, RoleLauncher } from "./types.js";

const silent = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

let root: string;
let okBin: string;
let failBin: string;
let noisyBin: string;
let hangBin: string;

function script(name: string, body: string): string {
  const p = path.join(root, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tz06-port-"));
  okBin = script("ok.sh", "echo done; exit 0");
  failBin = script("fail.sh", "echo partial; exit 3");
  noisyBin = script(
    "noisy.sh",
    `( sleep 0.3; echo LATE-AFTER-DEATH ) &
i=0
while [ $i -lt 200 ]; do printf '%01023d\\n' $i; i=$((i+1)); done
exit 0`,
  );
  hangBin = script("hang.sh", "trap '' TERM; sleep 30");
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const contract = (timeoutMs = 20_000) =>
  ({
    binding: { launcherId: "pi", model: "m", thinking: "low" },
    assets: {},
    timeoutMs,
    toolsSubset: null,
    requiresCapabilities: [],
  }) as unknown as ResolvedRoleContract;

function inputFor(cwd: string, timeoutMs?: number): LaunchInput {
  fs.mkdirSync(cwd, { recursive: true });
  const promptPath = path.join(cwd, "prompt.md");
  fs.writeFileSync(promptPath, "SYSTEM");
  return {
    runId: randomUUID(),
    attemptId: randomUUID(),
    cwd,
    promptPath,
    taskPrompt: "task",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root },
    contract: contract(timeoutMs),
  };
}

const hosts: Array<[string, (binary: string) => RoleLauncher]> = [
  ["pi", (binary) => createPiLauncher({ binary, flags: [] }, silent)],
  ["claude", (binary) => createClaudeLauncher({ binary, flags: [] }, silent)],
  ["codex", (binary) => createCodexLauncher({ binary, flags: [] }, silent)],
];

describe.each(hosts)("RoleLauncher contract — %s", (id, make) => {
  it("a clean run is `succeeded` with exit 0", async () => {
    const out = await make(okBin).launch(inputFor(path.join(root, `${id}-ok`)));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const res = await out.handle.completion;
    expect(res.status).toBe("succeeded");
    expect(res.exitCode).toBe(0);
  });

  it("a non-zero exit is `failed`, never `succeeded`", async () => {
    const out = await make(failBin).launch(
      inputFor(path.join(root, `${id}-fail`)),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const res = await out.handle.completion;
    expect(res.status).toBe("failed");
    expect(res.exitCode).toBe(3);
  });

  it("a missing binary is a typed binary-not-found, not a throw", async () => {
    const out = await make(path.join(root, "nope")).launch(
      inputFor(path.join(root, `${id}-missing`)),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const res = await out.handle.completion;
    expect(res.launchError?.kind).toBe("binary-not-found");
  });

  it("the session is per attempt and exists on disk", async () => {
    const cwd = path.join(root, `${id}-session`);
    const a = await make(okBin).launch(inputFor(cwd));
    const b = await make(okBin).launch(inputFor(cwd));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.handle.sessionRef).not.toBe(b.handle.sessionRef);
    expect(fs.existsSync(a.handle.sessionRef)).toBe(true);
    await Promise.all([a.handle.completion, b.handle.completion]);
  });

  it("late output is in the result and the buffer is bounded", async () => {
    const out = await make(noisyBin).launch(
      inputFor(path.join(root, `${id}-noisy`)),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const res = await out.handle.completion;
    expect(res.stdout).toContain("LATE-AFTER-DEATH");
    expect(Buffer.byteLength(res.stdout)).toBeLessThanOrEqual(
      OUTPUT_TAIL_BYTES,
    );
  });

  it("cancelAndWait is idempotent and agrees with completion", async () => {
    const out = await make(hangBin).launch(
      inputFor(path.join(root, `${id}-cancel`), 60_000),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const first = await out.handle.cancelAndWait();
    const second = await out.handle.cancelAndWait();
    expect(second).toEqual(first);
    expect(await out.handle.completion).toEqual(first);
  }, 20_000);
});
