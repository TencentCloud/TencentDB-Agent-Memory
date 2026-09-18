import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type RemoteSkillDetail,
  type RemoteSkillFile,
  type RemoteSkillSummary,
  type SkillSyncClient,
  syncAllSkills,
} from "../skill-sync.js";

const source = { proxyBase: "http://127.0.0.1:8096", spaceId: "space-a" };
const detail: RemoteSkillDetail = {
  skill_id: "skl-1",
  name: "deploy-check",
  version: 3,
  content: "---\nname: deploy-check\ndescription: Check a deployment safely\n---\n\nRun the health check first.\n",
  manifest: [{ path: "scripts/check.sh", size_bytes: 13 }],
};

class FakeClient implements SkillSyncClient {
  calls: Array<{ method: string; skillId?: string; path?: string }> = [];
  constructor(
    private readonly current: RemoteSkillDetail = detail,
    private readonly resourceContent = "echo healthy\n",
  ) {}

  async list(): Promise<RemoteSkillSummary[]> {
    this.calls.push({ method: "list" });
    return [{ skill_id: this.current.skill_id, name: this.current.name, version: this.current.version }];
  }

  async get(skillId: string): Promise<RemoteSkillDetail> {
    this.calls.push({ method: "get", skillId });
    return this.current;
  }

  async readFile(skillId: string, path: string): Promise<RemoteSkillFile> {
    this.calls.push({ method: "readFile", skillId, path });
    return { path, content: this.resourceContent, encoding: "utf-8" };
  }
}

const directories: string[] = [];

async function skillDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tdai-pi-skill-sync-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("syncAllSkills", () => {
  it("installs the current session's remote skill as a Pi-native skill", async () => {
    const directory = await skillDir();
    const client = new FakeClient();

    const results = await syncAllSkills(client, directory, source);

    expect(results).toEqual([{ skillId: "skl-1", name: "deploy-check", version: 3, status: "synced" }]);
    await expect(readFile(join(directory, "deploy-check", "SKILL.md"), "utf8")).resolves.toContain("Check a deployment");
    await expect(readFile(join(directory, "deploy-check", "scripts", "check.sh"), "utf8")).resolves.toBe("echo healthy\n");
    await expect(readFile(join(directory, "deploy-check", "tdai-remote.json"), "utf8")).resolves.toContain("skl-1");
    expect(client.calls).toEqual([
      { method: "list" },
      { method: "get", skillId: "skl-1" },
      { method: "readFile", skillId: "skl-1", path: "scripts/check.sh" },
    ]);
  });

  it("does not overwrite a hand-written same-name skill", async () => {
    const directory = await skillDir();
    const local = join(directory, "deploy-check");
    await (await import("node:fs/promises")).mkdir(local, { recursive: true });
    await writeFile(join(local, "SKILL.md"), "---\nname: deploy-check\ndescription: My local skill\n---\n\nKeep me.\n");

    const results = await syncAllSkills(new FakeClient(), directory, source);

    expect(results[0].status).toBe("skipped-user-owned");
    await expect(readFile(join(local, "SKILL.md"), "utf8")).resolves.toContain("Keep me.");
  });

  it("is idempotent when the remote version and content have not changed", async () => {
    const directory = await skillDir();
    const client = new FakeClient();

    await syncAllSkills(client, directory, source);
    const results = await syncAllSkills(client, directory, source);

    expect(results[0].status).toBe("up-to-date");
    expect(client.calls.filter((call) => call.method === "readFile")).toHaveLength(1);
  });

  it("rejects an unsafe remote resource before it writes a skill", async () => {
    const directory = await skillDir();
    const client = new FakeClient({ ...detail, manifest: [{ path: "../outside.txt" }] });

    const results = await syncAllSkills(client, directory, source);

    expect(results[0].status).toBe("failed");
    expect(results[0].error).toContain("unsafe resource path");
    await expect(readFile(join(directory, "deploy-check", "SKILL.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("updates a previously synced package, including its manifest resources", async () => {
    const directory = await skillDir();
    await syncAllSkills(new FakeClient(detail, "echo old\n"), directory, source);

    const newer = { ...detail, version: 4 };
    const results = await syncAllSkills(new FakeClient(newer, "echo current\n"), directory, source);

    expect(results[0].status).toBe("synced");
    await expect(readFile(join(directory, "deploy-check", "scripts", "check.sh"), "utf8")).resolves.toBe("echo current\n");
  });

  it("does not replace a managed skill with a different remote skill sharing its name", async () => {
    const directory = await skillDir();
    await syncAllSkills(new FakeClient(), directory, source);

    const competing = { ...detail, skill_id: "skl-2", version: 1 };
    const results = await syncAllSkills(new FakeClient(competing), directory, source);

    expect(results[0].status).toBe("skipped-remote-conflict");
    await expect(readFile(join(directory, "deploy-check", "tdai-remote.json"), "utf8")).resolves.toContain("skl-1");
  });
});
