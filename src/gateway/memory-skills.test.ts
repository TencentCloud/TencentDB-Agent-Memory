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
const TDAI = path.join(os.homedir(), ".pi", "agent-memory", "tdai");
const SKILLS_DST = path.join(TDAI, "skills");
const prompt = (name: string) =>
  path.join(REPO_ROOT, "src", "core", "prompts", name);

/**
 * Roles whose prompt is synced from the repo — must stay in step with
 * ROLE_FILES in the sync script. The live path is the one the gateway reads
 * at spawn time (`resolveRolePrompt` → `<roleDir>/<role>/prompt.md`).
 *
 * These are every role that can be spawned. The one live prompt left out is
 * roles/dedup-daily-critic/prompt.md: a critic is not a TDAI role (AGENTS.md),
 * it has no role.json, and the directory is on its way out — an unsynced
 * leftover, not a role missing its canonical.
 */
const SYNCED_ROLES = ["memory-keeper", "night-keeper", "dedup-daily"] as const;
const canonicalPrompt = (role: string) => prompt(`${role}.md`);
const livePrompt = (role: string) =>
  path.join(TDAI, "roles", role, "prompt.md");

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
      expect(
        runtime,
        `~/.pi/agent-memory/tdai/skills/${name}/SKILL.md parity`,
      ).toBe(canon);
    }
  });

  it("live role prompts parity (canon = the file the gateway reads at spawn)", () => {
    for (const role of SYNCED_ROLES) {
      const dst = livePrompt(role);
      expect(fs.readFileSync(dst, "utf-8"), `${dst} parity`).toBe(
        fs.readFileSync(canonicalPrompt(role), "utf-8"),
      );
    }
  });

  /**
   * Parity alone is not enough: `resolveRolePrompt` tries `prompt_file` FIRST,
   * and the keeper role.json files are not versioned in the repo. A prompt_file
   * pointing anywhere else sends the child to a different file while parity
   * stays green — which is exactly how memory-keeper ended up spawning on a
   * 6-byte stub. Scoped to the synced roles on purpose: the live tree also
   * holds probe fixtures (roles/broken/role.json is literally `{not json`).
   */
  it("every synced role names prompt.md as its prompt_file", () => {
    for (const role of SYNCED_ROLES) {
      const file = path.join(TDAI, "roles", role, "role.json");
      const { prompt_file: promptFile } = JSON.parse(
        fs.readFileSync(file, "utf-8"),
      ) as { prompt_file?: string };
      expect(promptFile, `${file} prompt_file`).toBe("prompt.md");
    }
  });

  /**
   * `diff.json` is the RESULT path the runner retired in favour of
   * out/result.json; a prompt that still names it tells the role to write where
   * nothing is read. Checked on the canonical prompts — the source every live
   * copy is now overwritten from — not on the copies.
   */
  it("no canonical role prompt names the retired result path diff.json", () => {
    for (const role of SYNCED_ROLES) {
      const file = canonicalPrompt(role);
      const stale = fs
        .readFileSync(file, "utf-8")
        .split("\n")
        .filter(
          (line) =>
            line.includes("diff.json") && !line.includes("снятое место входа"),
        );
      expect(stale, `${file} names diff.json as the role result`).toEqual([]);
    }
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
    for (const marker of ["1500", "2000", "META", "GET", "out/result.json"]) {
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
