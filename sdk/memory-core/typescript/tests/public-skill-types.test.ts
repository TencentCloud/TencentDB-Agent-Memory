import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { expect, test, vi } from "vitest";
import { SkillClient } from "../src/v3/skill-client.js";

const require = createRequire(import.meta.url);

test("published declarations expose skill method types at both entry points", () => {
  const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
  const sdk = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const temporary = mkdtempSync(join(tmpdir(), "memory-sdk-skill-types-"));
  try {
    const packageRoot = join(temporary, "package");
    mkdirSync(packageRoot);
    // Use the real package export map and freshly compiled declarations, never stale dist files.
    writeFileSync(join(packageRoot, "package.json"), readFileSync(join(sdk, "package.json")));
    symlinkSync(join(sdk, "node_modules"), join(packageRoot, "node_modules"), directoryLinkType);
    const tsc = require.resolve("typescript/bin/tsc");
    const compile = (args: string[]) => spawnSync(process.execPath, [tsc, ...args], {
      cwd: sdk,
      encoding: "utf8",
      timeout: 30_000,
    });
    const build = compile(["--project", join(sdk, "tsconfig.json"), "--outDir", join(packageRoot, "dist")]);
    expect(build.error, "declaration build must start successfully").toBeUndefined();
    expect(build.status, build.stdout + build.stderr).toBe(0);

    const modules = join(temporary, "node_modules", "@tencentdb-agent-memory");
    mkdirSync(modules, { recursive: true });
    symlinkSync(packageRoot, join(modules, "memory-sdk-ts-v2"), directoryLinkType);
    const consumer = join(temporary, "consumer.mts");
    writeFileSync(consumer, `
import type { SkillGetByNameRequest, SkillExportRequest, SkillExportData } from "@tencentdb-agent-memory/memory-sdk-ts-v2";
import type { SkillGetByNameRequest as V3Name, SkillExportRequest as V3Request, SkillExportData as V3Data } from "@tencentdb-agent-memory/memory-sdk-ts-v2/v3";
const named: SkillGetByNameRequest = { team_id: "team", agent_id: "agent", skill_name: "skill" };
const archive: SkillExportRequest = { skill_id: "skill-1", format: "zip" };
const sameName: V3Name = named;
const sameRequest: V3Request = archive;
function sameData(value: SkillExportData): V3Data { return value; }
`);
    const checked = compile(["--noEmit", "--strict", "--skipLibCheck", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", consumer]);
    expect(checked.error, "consumer typecheck must start successfully").toBeUndefined();
    expect(checked.status, checked.stdout + checked.stderr).toBe(0);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}, 60_000);

test("skill methods preserve their request payloads", async () => {
  const named = { team_id: "team", agent_id: "agent", skill_name: "skill" };
  const archive = { skill_id: "skill-1", format: "zip" as const };
  const post = vi.fn().mockResolvedValue({});
  const client = new SkillClient({ post });
  await client.getByName(named);
  await client.exportSkill(archive);
  expect(post).toHaveBeenNthCalledWith(1, "/v3/skill/get-by-name", named);
  expect(post).toHaveBeenNthCalledWith(2, "/v3/skill/export", archive);
});
