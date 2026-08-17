import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { fetchRemoteSkill, installSyncedSkill, listSyncCandidates } from "../src/skill-sync.js";

// Delegates to the real fs for every operation except the staging->target
// rename, which can be made to fail deterministically in the rollback test.
const failStagingRename = vi.hoisted(() => ({ current: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string | URL | Buffer, to: string | URL | Buffer) => {
      const f = String(from);
      const t = String(to);
      if (failStagingRename.current && f.includes(".tdai-sync-staging") && t.includes("node-build-oom-triage")) {
        throw new Error("simulated rename failure");
      }
      return actual.rename(from, to);
    },
  };
});

const directories: string[] = [];

async function agentDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tdai-sync-test-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  failStagingRename.current = false;
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function skillClient(getResult: Record<string, unknown> = {}) {
  return {
    list: vi.fn().mockResolvedValue({ items: [{ skill_id: "skl-1", name: "node-build-oom-triage", version: 1, is_head: true, status: "active", owner_user_id: "u", owner_agent_id: "a", team_id: "t", task_id: "", created_at_ms: 1, updated_at_ms: 1, description: "fix oom" }], total: 1 }),
    get: vi.fn().mockResolvedValue({
      skill_id: "skl-1",
      name: "node-build-oom-triage",
      description: "Fix an intermittent OOM during Node builds.",
      version: 3,
      is_head: true,
      status: "active",
      owner_user_id: "u",
      owner_agent_id: "a",
      team_id: "t",
      task_id: "",
      created_at_ms: 1,
      updated_at_ms: 2,
      content: "---\nname: node-build-oom-triage\ndescription: Fix an intermittent OOM during Node builds.\n---\n\n# Node build OOM triage\n\nWhen the build intermittently OOMs, set NODE_OPTIONS=--max-old-space-size=4096.\n",
      manifest: [
        { path: "scripts/run.sh", size_bytes: 12, mime_type: "text/plain", is_executable: true },
      ],
      ...getResult,
    }),
    readFile: vi.fn().mockResolvedValue({
      path: "scripts/run.sh",
      content: "echo hello",
      encoding: "utf-8",
      size_bytes: 12,
      mime_type: "text/plain",
      version: 3,
    }),
  } as never;
}

function validSkillMd(name = "node-build-oom-triage"): string {
  return `---\nname: ${name}\ndescription: Fix an intermittent OOM during Node builds.\n---\n\n# Node build OOM triage\n\nBody content.\n`;
}

function markerContent(): string {
  return JSON.stringify({ adapter: "tdai-memory", skillId: "skl-1", version: 3 });
}

describe("listSyncCandidates", () => {
  it("returns the server skill list", async () => {
    const skill = skillClient();
    const candidates = await listSyncCandidates(skill as never);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.name).toBe("node-build-oom-triage");
  });
});

describe("fetchRemoteSkill", () => {
  it("rejects path-traversal and absolute resource paths", async () => {
    for (const bad of ["../../x", "/etc/passwd", "C:\\windows\\x", "..\\..\\x", "a/../../x", "x\0y"]) {
      const skill = skillClient({ content: validSkillMd(), manifest: [{ path: bad, size_bytes: 1, mime_type: "text/plain", is_executable: false }] });
      await expect(fetchRemoteSkill(skill as never, "skl-1")).rejects.toThrow(/unsafe resource path/);
    }
  });

  it("rejects an invalid or missing frontmatter name", async () => {
    for (const content of [
      "---\nname: Bad_Name\ndescription: ok\n---\nbody",
      "---\nname: node--double\ndescription: ok\n---\nbody",
      "---\nname: -leading\ndescription: ok\n---\nbody",
      "---\nname: trailing-\ndescription: ok\n---\nbody",
      "---\ndescription: missing name\n---\nbody",
    ]) {
      const skill = skillClient({ content });
      await expect(fetchRemoteSkill(skill as never, "skl-1")).rejects.toThrow(/invalid skill name/);
    }
  });

  it("rejects an empty description", async () => {
    const skill = skillClient({ content: "---\nname: node-build-oom-triage\ndescription:  \n---\nbody" });
    await expect(fetchRemoteSkill(skill as never, "skl-1")).rejects.toThrow(/empty description/);
  });

  it("rejects an oversized SKILL.md", async () => {
    const huge = validSkillMd() + "x".repeat(1_050_000);
    const skill = skillClient({ content: huge });
    await expect(fetchRemoteSkill(skill as never, "skl-1")).rejects.toThrow(/exceeds 1048576 bytes/);
  });

  it("rejects an oversized resource", async () => {
    const skill = skillClient({
      content: validSkillMd(),
      manifest: [{ path: "scripts/big.bin", size_bytes: 6_000_000, mime_type: "application/octet-stream", is_executable: false }],
    });
    await expect(fetchRemoteSkill(skill as never, "skl-1")).rejects.toThrow(/exceeds 5242880 bytes/);
  });
});

describe("installSyncedSkill", () => {
  it("installs a valid skill into Pi's skills dir with a marker, and Pi discovers it", async () => {
    const dir = await agentDir();
    const skill = skillClient();
    const result = await installSyncedSkill({ skill: skill as never, agentDir: dir, skillId: "skl-1", source: { endpoint: "http://x", teamId: "t", agentId: "a" } });

    expect(result.status).toBe("synced");
    expect(result.name).toBe("node-build-oom-triage");

    const skillMd = await readFile(join(dir, "skills", "node-build-oom-triage", "SKILL.md"), "utf8");
    expect(skillMd).toContain("Node build OOM triage");
    expect(await readFile(join(dir, "skills", "node-build-oom-triage", "scripts", "run.sh"), "utf8")).toBe("echo hello");

    const marker = JSON.parse(await readFile(join(dir, "skills", "node-build-oom-triage", "tdai-remote.json"), "utf8")) as { adapter: string; skillId: string; version: number };
    expect(marker.adapter).toBe("tdai-memory");
    expect(marker.skillId).toBe("skl-1");
    expect(marker.version).toBe(3);

    const loaded = loadSkillsFromDir({ dir: join(dir, "skills"), source: "user" });
    expect(loaded.skills.map((s) => s.name)).toContain("node-build-oom-triage");
    expect(loaded.diagnostics).toHaveLength(0);
  });

  it("skips a name already owned by a user-written skill (no marker)", async () => {
    const dir = await agentDir();
    const userDir = join(dir, "skills", "node-build-oom-triage");
    await mkdir(userDir, { recursive: true });
    await writeFile(join(userDir, "SKILL.md"), validSkillMd(), "utf8");

    const result = await installSyncedSkill({ skill: skillClient() as never, agentDir: dir, skillId: "skl-1" });
    expect(result.status).toBe("skipped-user-owned");
    // User content untouched.
    expect(await readFile(join(userDir, "SKILL.md"), "utf8")).toBe(validSkillMd());
    expect(await readFile(join(dir, "skills", "node-build-oom-triage", "tdai-remote.json"), "utf8").catch(() => "")).toBe("");
  });

  it("replaces a previously-synced skill when the version changed", async () => {
    const dir = await agentDir();
    const target = join(dir, "skills", "node-build-oom-triage");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), validSkillMd() + "\nOLD", "utf8");
    await writeFile(join(target, "tdai-remote.json"), markerContent(), "utf8");

    const result = await installSyncedSkill({ skill: skillClient() as never, agentDir: dir, skillId: "skl-1" });
    expect(result.status).toBe("synced");
    const fresh = await readFile(join(target, "SKILL.md"), "utf8");
    expect(fresh).toContain("Node build OOM triage");
    expect(fresh).not.toContain("OLD");
  });

  it("rolls back to the previous version when the atomic replace fails", async () => {
    const dir = await agentDir();
    const target = join(dir, "skills", "node-build-oom-triage");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), "---\nname: node-build-oom-triage\ndescription: old\n---\nOLD VERSION", "utf8");
    await writeFile(join(target, "tdai-remote.json"), markerContent(), "utf8");

    failStagingRename.current = true;

    await expect(installSyncedSkill({ skill: skillClient() as never, agentDir: dir, skillId: "skl-1" })).rejects.toThrow(/simulated rename failure/);
    // Previous version intact.
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toContain("OLD VERSION");
  });
});
