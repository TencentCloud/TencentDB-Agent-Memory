/**
 * Write-path scoping: I4 (project scope without a project id is downgraded and
 * logged) and the dedup scope boundary (never merge across scopes).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeMemory } from "./l1-writer.js";
import { sameScope } from "./l1-dedup.js";
import type { ExtractedMemory } from "./l1-writer.js";

const extracted: ExtractedMemory = {
  content: "the deploy script lives in scripts/deploy.sh",
  type: "episodic",
  priority: 50,
  source_message_ids: [],
  metadata: {},
  scene_name: "test",
  scope: "project",
};

function write(projectId: string | undefined, warns: string[]) {
  return writeMemory({
    memory: extracted,
    decision: { record_id: "m_1", action: "store", target_ids: [] },
    baseDir: fs.mkdtempSync(path.join(os.tmpdir(), "tdai-write-")),
    sessionKey: "cc-test",
    projectId,
    logger: { info: () => {}, warn: (m: string) => warns.push(m), error: () => {} } as never,
  });
}

describe("resolveScope (I4)", () => {
  it("keeps project scope when a project id is present", async () => {
    const warns: string[] = [];
    const rec = await write("/repo/a", warns);
    expect(rec?.scope).toBe("project");
    expect(rec?.projectId).toBe("/repo/a");
    expect(warns).toEqual([]);
  });

  it("downgrades to global and warns when the project id is missing", async () => {
    const warns: string[] = [];
    const rec = await write(undefined, warns);
    expect(rec?.scope).toBe("global");
    expect(warns.join("\n")).toMatch(/project_id is empty/);
  });
});

describe("sameScope (dedup boundary)", () => {
  it("rejects merge candidates from a different scope or project", () => {
    expect(sameScope({ scope: "global" }, "project", "/repo/a")).toBe(false);
    expect(sameScope({ scope: "project", project_id: "/repo/b" }, "project", "/repo/a")).toBe(false);
    expect(sameScope({ scope: "project", project_id: "/repo/a" }, "project", "/repo/a")).toBe(true);
    expect(sameScope({ scope: "global" }, "global", "/repo/a")).toBe(true);
    expect(sameScope({}, "project", "/repo/a")).toBe(true); // legacy candidate
  });
});
