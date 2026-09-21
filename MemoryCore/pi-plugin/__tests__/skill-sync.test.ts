import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type RemoteSkillDetail,
  type RemoteSkillFile,
  type RemoteSkillSummary,
  type SkillSyncClient,
  SkillBridgeClient,
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

describe("SkillBridgeClient.list", () => {
  it.each([0, 50, 51, 101])("lists all %i skills using Core pagination", async (count) => {
    const skills = Array.from({ length: count }, (_, i) => ({ skill_id: `skl-${i}`, name: `skill-${i}`, version: 1 }));
    const offsets: number[] = [];
    const client = new SkillBridgeClient({
      ...source, userKey: "user-key", conversationId: "pi-session",
      fetcher: async (_input, init) => {
        const { pagination } = JSON.parse(String(init?.body));
        offsets.push(pagination.offset);
        return new Response(JSON.stringify({ code: 0, data: {
          items: skills.slice(pagination.offset, pagination.offset + pagination.limit), total: count,
        } }));
      },
    });

    expect(await client.list()).toEqual(skills);
    expect(offsets).toEqual(Array.from({ length: Math.max(1, Math.ceil(count / 50)) }, (_, i) => i * 50));
  });

  it("rejects a later page failure instead of returning a partial list", async () => {
    const client = new SkillBridgeClient({
      ...source, userKey: "user-key", conversationId: "pi-session",
      fetcher: async (_input, init) => {
        const { pagination } = JSON.parse(String(init?.body));
        if (pagination.offset > 0) {
          return new Response(JSON.stringify({ code: 50001, message: "list unavailable" }), { status: 500 });
        }
        return new Response(JSON.stringify({ code: 0, data: {
          items: Array.from({ length: 50 }, (_, i) => ({ skill_id: `skl-${i}`, name: `skill-${i}`, version: 1 })),
          total: 51,
        } }));
      },
    });

    await expect(client.list()).rejects.toThrow("list unavailable");
  });
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

  it.each([false, true])("preserves a skill made user-owned during download (update=%s)", async (update) => {
    const directory = await skillDir();
    const local = join(directory, detail.name);
    if (update) await syncAllSkills(new FakeClient(), directory, source);
    const client = new FakeClient({ ...detail, version: detail.version + 1 });
    client.readFile = async (_skillId, path) => {
      await mkdir(local, { recursive: true });
      await rm(join(local, "tdai-remote.json"), { force: true });
      await writeFile(join(local, "SKILL.md"), "My hand-written skill.\n");
      return { path, content: "echo remote\n", encoding: "utf-8" };
    };

    const results = await syncAllSkills(client, directory, source);

    expect(results[0].status).toBe("skipped-user-owned");
    expect(await readFile(join(local, "SKILL.md"), "utf8")).toBe("My hand-written skill.\n");
    await expect(readFile(join(local, "tdai-remote.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(directory)).toEqual([detail.name]);
  });

  it("requests base64 and preserves binary resource bytes through the Bridge client", async () => {
    const directory = await skillDir();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
    const binaryDetail = { ...detail, manifest: [{ path: "assets/image.png", size_bytes: bytes.length }] };
    const requests: Record<string, unknown>[] = [];
    const client = new SkillBridgeClient({
      ...source, userKey: "user-key", conversationId: "pi-session",
      fetcher: async (input, init) => {
        const url = String(input);
        let data: unknown = binaryDetail;
        if (url.endsWith("/list")) data = { items: [binaryDetail] };
        if (url.endsWith("/files/read")) {
          const body = JSON.parse(String(init?.body));
          requests.push(body);
          // Match Core's default UTF-8 response unless base64 is requested.
          const encoding = body.encoding === "base64" ? "base64" : "utf-8";
          data = { path: body.path, content: bytes.toString(encoding), encoding };
        }
        return new Response(JSON.stringify({ code: 0, data }));
      },
    });

    const results = await syncAllSkills(client, directory, source);

    expect(results[0].status).toBe("synced");
    expect(requests).toEqual([{ skill_id: detail.skill_id, path: "assets/image.png", encoding: "base64" }]);
    expect(await readFile(join(directory, detail.name, "assets/image.png"))).toEqual(bytes);
  });

  it.skipIf(process.platform === "win32")("preserves executable flags without making other files executable", async () => {
    const directory = await skillDir();
    const client = new FakeClient({
      ...detail,
      manifest: [
        { path: "scripts/check.sh", is_executable: true },
        { path: "templates/config.txt", is_executable: false },
        { path: "references/notes.txt" },
      ],
    });

    const results = await syncAllSkills(client, directory, source);

    expect(results[0].status).toBe("synced");
    const local = join(directory, detail.name);
    expect((await stat(join(local, "scripts/check.sh"))).mode & 0o100).toBe(0o100);
    for (const path of ["templates/config.txt", "references/notes.txt", "SKILL.md", "tdai-remote.json"]) {
      expect((await stat(join(local, path))).mode & 0o111).toBe(0);
    }
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
