import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { OffloadStateManager } from "../state-manager.js";
import { writeMmd } from "../storage.js";
import { handleTaskTransition } from "./before-agent-start.js";

const tempRoots: string[] = [];

async function makeStateManager(): Promise<{ root: string; manager: OffloadStateManager }> {
  const root = await mkdtemp(join(tmpdir(), "tdai-offload-mmd-"));
  tempRoots.push(root);
  const manager = new OffloadStateManager();
  await manager.init(root, "agent", "session");
  return { root, manager };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function expectInside(parent: string, child: string): void {
  const rel = relative(parent, child);
  expect(rel).not.toBe("");
  expect(rel.startsWith("..")).toBe(false);
  expect(rel).not.toMatch(/^([A-Za-z]:)?[/\\]/);
}

describe("handleTaskTransition", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("sanitizes new task labels before creating MMD files", async () => {
    const { manager } = await makeStateManager();

    await handleTaskTransition(
      manager,
      {
        taskCompleted: true,
        isContinuation: false,
        isLongTask: true,
        newTaskLabel: "../../../../escaped",
      },
      {},
    );

    const activeMmd = manager.getActiveMmdFile();
    expect(activeMmd).toBeTruthy();
    expect(activeMmd).not.toContain("/");
    expect(activeMmd).not.toContain("..");
    expectInside(manager.ctx.mmdsDir, join(manager.ctx.mmdsDir, activeMmd!));
  });

  it("keeps direct MMD writes inside the mmds directory", async () => {
    const { root, manager } = await makeStateManager();

    await writeMmd(manager.ctx, "../../escaped.mmd", "flowchart TD\n");

    expect(await exists(join(root, "escaped.mmd"))).toBe(false);
    expect(await exists(join(manager.ctx.mmdsDir, "escaped.mmd"))).toBe(true);
  });
});
