/**
 * Memory-role skills: parity (canonical repo = runtime ~/.pi/agent/skills/)
 * + criteria grep-asserts. The runtime copies are produced by
 * scripts/sync-memory-skills.sh; a parity break means the sync was not run
 * after an edit — the keeper/night sessions would load stale criteria.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const SKILLS_SRC = path.join(REPO_ROOT, "src", "core", "prompts", "skills");
// Runtime copies now live in tdai (forked task-cycle per-role skills); the
// repo canonical is the single source, synced by scripts/sync-memory-skills.sh.
const SKILLS_DST = path.join(
  os.homedir(),
  ".pi",
  "agent-memory",
  "tdai",
  "skills",
);
const ROLE_SRC = path.join(
  REPO_ROOT,
  "src",
  "core",
  "prompts",
  "night-keeper.md",
);
const ROLE_DST = path.join(
  os.homedir(),
  ".pi",
  "agent-memory",
  "tdai",
  "memory-keeper",
  "night-keeper.md",
);

const SKILL_NAMES = [
  "memory-keeper",
  "memory-critic",
  "night-keeper",
  "night-critic",
  "dedup-daily",
  "dedup-daily-critic",
] as const;

describe("memory-role skills parity (canon = runtime)", () => {
  it("all 4 canonical skills exist in the repo", () => {
    for (const name of SKILL_NAMES) {
      expect(
        fs.existsSync(path.join(SKILLS_SRC, name, "SKILL.md")),
        `${name}/SKILL.md`,
      ).toBe(true);
    }
  });

  it("runtime copies equal canonical (parity — sync-memory-skills.sh must have been run)", () => {
    for (const name of SKILL_NAMES) {
      const canon = fs.readFileSync(
        path.join(SKILLS_SRC, name, "SKILL.md"),
        "utf-8",
      );
      const runtime = fs.readFileSync(
        path.join(SKILLS_DST, name, "SKILL.md"),
        "utf-8",
      );
      expect(runtime, `~/.pi/agent-memory/tdai/skills/${name}/SKILL.md parity`).toBe(canon);
    }
  });

  it("night-keeper role file parity (canon = runtime)", () => {
    const canon = fs.readFileSync(ROLE_SRC, "utf-8");
    const runtime = fs.readFileSync(ROLE_DST, "utf-8");
    expect(runtime).toBe(canon);
  });

  it("night-keeper skill derives base memory-keeper criteria (single source)", () => {
    const night = fs.readFileSync(
      path.join(SKILLS_SRC, "night-keeper", "SKILL.md"),
      "utf-8",
    );
    const base = fs.readFileSync(
      path.join(SKILLS_SRC, "memory-keeper", "SKILL.md"),
      "utf-8",
    );
    for (const marker of ["1500", "2000", "META", "GET", "diff.json"]) {
      expect(night, `night-keeper missing base marker "${marker}"`).toContain(
        marker,
      );
      expect(base, `memory-keeper missing base marker "${marker}"`).toContain(
        marker,
      );
    }
  });

  it("night-critic skill derives read-only memory-critic criteria, NOT keeper write semantics", () => {
    const nc = fs.readFileSync(
      path.join(SKILLS_SRC, "night-critic", "SKILL.md"),
      "utf-8",
    );
    const mc = fs.readFileSync(
      path.join(SKILLS_SRC, "memory-critic", "SKILL.md"),
      "utf-8",
    );
    for (const marker of ["presented", "META", "GET", "REJECT"]) {
      expect(nc, `night-critic missing base marker "${marker}"`).toContain(
        marker,
      );
      expect(mc, `memory-critic missing base marker "${marker}"`).toContain(
        marker,
      );
    }
  });

  it("night criteria are present (cleanup/даты/батчи) in both night skills", () => {
    const nk = fs.readFileSync(
      path.join(SKILLS_SRC, "night-keeper", "SKILL.md"),
      "utf-8",
    );
    const nc = fs.readFileSync(
      path.join(SKILLS_SRC, "night-critic", "SKILL.md"),
      "utf-8",
    );
    for (const marker of ["cleanup", "rewriteRecord", "даты", "батч"]) {
      expect(nk, `night-keeper missing night marker "${marker}"`).toContain(
        marker,
      );
      expect(nc, `night-critic missing night marker "${marker}"`).toContain(
        marker,
      );
    }
  });
});
