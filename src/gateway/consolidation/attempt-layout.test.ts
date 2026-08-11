/**
 * The §3.5 layout resolution (tz-02 критерий 4a). The branch that matters is
 * which file answers as "the result" — a wrong answer either loses a fresh
 * candidate or applies a stale one.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureAttemptLayout,
  resolveResultPath,
  writeWorkset,
  LEGACY_RESULT_REL,
  RESULT_REL,
  WORKSET_REL,
} from "./attempt-layout.js";

let dir: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-layout-"));
  await ensureAttemptLayout(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("attempt layout", () => {
  it("creates input/ and out/ so writers do not have to", () => {
    expect(fs.existsSync(path.join(dir, "input"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "out"))).toBe(true);
  });

  it("writes the workset where the role is told to look", async () => {
    await writeWorkset(dir, {
      runId: "r1",
      role: "memory-keeper",
      presentedRecordIds: ["a", "b"],
      cursor: "2026-08-01T00:00:00Z",
      generatedAt: "2026-08-11T00:00:00Z",
      presentedDiffPath: "presented-diff.md",
    });
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dir, WORKSET_REL), "utf-8"),
    ) as { presentedRecordIds: string[] };
    expect(parsed.presentedRecordIds).toEqual(["a", "b"]);
  });

  it("prefers the new path over a stale legacy one", () => {
    fs.writeFileSync(path.join(dir, LEGACY_RESULT_REL), "{}", "utf-8");
    fs.writeFileSync(path.join(dir, RESULT_REL), "{}", "utf-8");
    const resolved = resolveResultPath(dir);
    expect(resolved.legacy).toBe(false);
    expect(resolved.path).toBe(path.join(dir, RESULT_REL));
  });

  it("falls back to the retired path when the new one is absent", () => {
    fs.writeFileSync(path.join(dir, LEGACY_RESULT_REL), "{}", "utf-8");
    const resolved = resolveResultPath(dir);
    expect(resolved.legacy).toBe(true);
    expect(resolved.path).toBe(path.join(dir, LEGACY_RESULT_REL));
  });

  it("names the retired path when neither exists — the error says where it looked", () => {
    // Not "throws": the caller reports "missing or malformed in <path>", and
    // that path has to be the one a rollback would use.
    expect(resolveResultPath(dir).path).toBe(path.join(dir, LEGACY_RESULT_REL));
  });
});
