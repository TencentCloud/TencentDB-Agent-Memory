/**
 * P6 — forked task-cycle spawn args (path б).
 *
 * buildRoleSpawnArgs maps role.json `runtime.extension_path` / `skill_path`
 * to `--extension` / `--skill` CLI args for the keeper sub-session. Tested
 * against an isolated tmp roleDir (no os.homedir() dependency).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRoleSpawnArgs } from "./role-spawn-args.js";

function fakeRoleDir(role: string, runtime?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-spawn-args-"));
  fs.mkdirSync(path.join(dir, role), { recursive: true });
  const cfg = {
    name: role,
    model: "opencode-go/deepseek-v4-flash",
    prompt_file: `${role}.md`,
    enabled: true,
    thinking: "low",
    timeout_min: 10,
    scope: "fresh_tail",
    trigger: "manual_only",
    schedule: null,
    threshold: null,
    idsOnly: false,
    diff_cap: 20,
    diff_byte_cap: 8192,
    ops_subset: [],
    tools_subset: [],
    caps: { delete_per_run: 0, rewrite_per_run: 0 },
    max_run_ms: 1_800_000,
    fail_on_missing_prompt: false,
    critic_role: null,
    ...(runtime ? { runtime } : {}),
  };
  fs.writeFileSync(
    path.join(dir, role, "role.json"),
    JSON.stringify(cfg),
    "utf-8",
  );
  fs.writeFileSync(path.join(dir, role, "prompt.md"), "ROLE", "utf-8");
  return dir;
}

function childCtx(role: string) {
  return {
    role,
    env: {},
    promptPath: "/tmp/prompt.md",
    cwd: "/tmp",
  } as never;
}

describe("buildRoleSpawnArgs (forked task-cycle path б)", () => {
  it("emits --no-extensions/--extension/--skill from runtime.extension_path/skill_path", () => {
    const roleDir = fakeRoleDir("memory-keeper", {
      extension_path: "/ext/task-cycle-memory-keeper/index.ts",
      skill_path: "/skills/memory-keeper/SKILL.md",
    });
    const args = buildRoleSpawnArgs(childCtx("memory-keeper"), roleDir);
    expect(args).toEqual([
      "--no-extensions",
      "--extension",
      "/ext/task-cycle-memory-keeper/index.ts",
      "--skill",
      "/skills/memory-keeper/SKILL.md",
    ]);
  });

  it("legacy role without runtime → no extra args", () => {
    const roleDir = fakeRoleDir("night-keeper");
    const args = buildRoleSpawnArgs(childCtx("night-keeper"), roleDir);
    expect(args).toEqual([]);
  });

  it("missing role dir → no extra args (never throws)", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-empty-roles-"));
    const args = buildRoleSpawnArgs(childCtx("ghost-role"), empty);
    expect(args).toEqual([]);
  });
});
