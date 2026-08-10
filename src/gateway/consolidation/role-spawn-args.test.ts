/**
 * P6 — forked task-cycle spawn args (path б).
 *
 * buildRoleSpawnArgs maps the RESOLVED contract's instance assets
 * (role.json `runtime.extension_path` / `skill_path`) to `--extension` /
 * `--skill` CLI args for the keeper sub-session. tz-01 B1: the args come
 * from the contract, so the test resolves a real role dir first instead of
 * re-reading role.json itself.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRoleSpawnArgs } from "./role-spawn-args.js";
import {
  resolveRoleContract,
  clearRoleContractCache,
} from "./role-contract.js";
import type { RoleLegacyDefaults } from "./role-contract-types.js";

const LEGACY: RoleLegacyDefaults = {
  failOpenPromptRoles: ["memory-keeper"],
  model: "legacy/global-model",
  thinking: "low",
  timeoutMs: 600_000,
  diffCap: 20,
  diffByteCap: 8192,
  night: {
    diffCap: 200,
    diffByteCap: 32_768,
    deleteCapPerRun: 50,
    rewriteCapPerRun: 100,
    maxRunMs: 5_400_000,
  },
};

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
  fs.writeFileSync(path.join(dir, role, `${role}.md`), "ROLE", "utf-8");
  return dir;
}

function argsFor(role: string, roleDir: string): string[] {
  const res = resolveRoleContract(role, roleDir, LEGACY);
  if (!res.ok) throw new Error(`role did not resolve: ${res.reason}`);
  return buildRoleSpawnArgs(res.contract);
}

describe("buildRoleSpawnArgs (forked task-cycle path б)", () => {
  beforeEach(() => clearRoleContractCache());

  it("emits --no-extensions/--extension/--skill from runtime.extension_path/skill_path", () => {
    const roleDir = fakeRoleDir("memory-keeper", {
      extension_path: "/ext/task-cycle-memory-keeper/index.ts",
      skill_path: "/skills/memory-keeper/SKILL.md",
    });
    expect(argsFor("memory-keeper", roleDir)).toEqual([
      "--no-extensions",
      "--extension",
      "/ext/task-cycle-memory-keeper/index.ts",
      "--skill",
      "/skills/memory-keeper/SKILL.md",
    ]);
  });

  it("legacy role without runtime → no extra args", () => {
    const roleDir = fakeRoleDir("night-keeper");
    expect(argsFor("night-keeper", roleDir)).toEqual([]);
  });

  it("role with no role.json → adapter contract, no extra args (never throws)", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-empty-roles-"));
    expect(argsFor("memory-keeper", empty)).toEqual([]);
  });
});
