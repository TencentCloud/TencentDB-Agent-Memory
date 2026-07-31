import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildOpenClawRecallHookResult } from "./recall-injection.js";

const openClawRoot = process.env.OPENCLAW_2026_5_28_ROOT;

describe.skipIf(!openClawRoot)("OpenClaw 2026.5.28 prompt-cache boundary", () => {
  it("places the stable snapshot before the real host cache boundary", async () => {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(openClawRoot!, "package.json"), "utf8"),
    ) as { version: string };
    expect(packageJson.version).toBe("2026.5.28");

    const threadHelpers = await import(pathToFileURL(path.join(
      openClawRoot!,
      "dist/attempt.thread-helpers-DrgOy9AX.js",
    )).href) as {
      n: (params: {
        baseSystemPrompt: string;
        prependSystemContext?: string;
        appendSystemContext?: string;
      }) => string | undefined;
    };
    const cacheBoundary = await import(pathToFileURL(path.join(
      openClawRoot!,
      "dist/system-prompt-cache-boundary-JukSqUUt.js",
    )).href) as {
      i: (text: string) => string;
      r: (text: string) => { stablePrefix: string; dynamicSuffix: string } | undefined;
      t: string;
    };

    const stableSnapshot = "<user-persona>stable memory</user-persona>";
    const hook = buildOpenClawRecallHookResult({
      appendSystemContext: stableSnapshot,
      prependContext: "<relevant-memories>turn delta</relevant-memories>",
    }, "append");
    const finalSystemPrompt = threadHelpers.n({
      baseSystemPrompt: `OPENCLAW STABLE${cacheBoundary.t}OPENCLAW DYNAMIC`,
      prependSystemContext: hook.prependSystemContext,
    })!;
    const split = cacheBoundary.r(finalSystemPrompt)!;

    expect(split.stablePrefix).toContain(stableSnapshot);
    expect(split.dynamicSuffix).not.toContain(stableSnapshot);
    expect(hook.appendContext).toContain("turn delta");
    expect(cacheBoundary.i(finalSystemPrompt).startsWith(stableSnapshot)).toBe(true);

    const appendControl = cacheBoundary.r(threadHelpers.n({
      baseSystemPrompt: `OPENCLAW STABLE${cacheBoundary.t}OPENCLAW DYNAMIC`,
      appendSystemContext: stableSnapshot,
    })!)!;
    expect(appendControl.dynamicSuffix).toContain(stableSnapshot);
  });
});
