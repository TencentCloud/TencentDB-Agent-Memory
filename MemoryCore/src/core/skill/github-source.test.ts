import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { fetchGitHubSkill } from "./github-source.js";
const commit = "a".repeat(40);
const skill =
  "---\nname: demo\ndescription: Demo skill\nversion: 1.0\n---\nRead references/guide.md.";
const blob = (text: string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0${text}`)
    .digest("hex");
function github() {
  const files = {
    "skills/demo/SKILL.md": skill,
    "skills/demo/references/guide.md": "Guide",
    "unrelated.md": "outside",
  };
  const requests: string[] = [];
  const client: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    requests.push(path);
    expect(init?.redirect).toBe("error");
    if (path.endsWith("/commits/HEAD"))
      return Response.json({
        sha: commit,
        commit: { tree: { sha: "b".repeat(40) } },
      });
    if (path.includes("/git/trees/"))
      return Response.json({
        truncated: false,
        tree: Object.entries(files).map(([path, text]) => ({
          path,
          type: "blob",
          mode: "100644",
          size: Buffer.byteLength(text),
          sha: blob(text),
        })),
      });
    const text = Object.values(files).find((text) => path.endsWith(blob(text)));
    if (text !== undefined)
      return Response.json({
        encoding: "base64",
        size: Buffer.byteLength(text),
        content: Buffer.from(text).toString("base64"),
        sha: blob(text),
      });
    throw new Error(`Unexpected request: ${url}`);
  };
  return { client, requests };
}
describe("public GitHub skill snapshots", () => {
  it("resolves the ref once and imports only the selected subtree with verifiable bytes", async () => {
    const f = github();
    const result = await fetchGitHubSkill(
      {
        repository: "https://github.com/example/skills.git",
        path: "skills/demo",
      },
      f.client,
    );
    expect(result.source.commit).toBe(commit);
    expect(result.source.declared_version).toBe("1");
    expect(result.source.repository).toBe("https://github.com/example/skills");
    expect(result.content).toBe(skill);
    expect(
      result.resources.map((r: any) => [
        r.path,
        Buffer.from(r.content, "base64").toString(),
      ]),
    ).toEqual([["references/guide.md", "Guide"]]);
    expect(f.requests.filter((p) => p.includes("/commits/"))).toHaveLength(1);
    expect(f.requests).not.toContain(
      `/repos/example/skills/git/blobs/${blob("outside")}`,
    );
  });
});

describe("GitHub import boundaries", () => {
  it.each([
    "http://github.com/example/skills",
    "https://github.com.evil.test/example/skills",
    "https://user:secret@github.com/example/skills",
    "https://github.com/example/skills?token=secret",
    "https://github.com/example/../skills",
    "https://127.0.0.1/example/skills",
  ])("rejects %s before any network request", async (repository) => {
    const f = github();
    await expect(fetchGitHubSkill({ repository }, f.client)).rejects.toThrow();
    expect(f.requests).toEqual([]);
  });
  it.each(["../demo", "/demo", "demo/../other", "demo\\other", "demo//other"])(
    "rejects unsafe subdirectory %s",
    async (path) => {
      const f = github();
      await expect(
        fetchGitHubSkill(
          { repository: "https://github.com/example/skills", path },
          f.client,
        ),
      ).rejects.toThrow();
      expect(f.requests).toEqual([]);
    },
  );
  it.each([
    "truncated",
    "symlink",
    "submodule",
    "oversized",
    "duplicate",
    "traversal",
    "missing",
  ])("rejects %s trees before downloading blobs", async (fault) => {
    const f = github();
    const client: typeof fetch = async (url, init) => {
      const response = await f.client(url, init);
      if (!String(url).includes("/git/trees/")) return response;
      const tree = (await response.json()) as any;
      if (fault === "truncated") tree.truncated = true;
      if (fault === "symlink") tree.tree[0].mode = "120000";
      if (fault === "submodule") {
        tree.tree[0].mode = "160000";
        tree.tree[0].type = "commit";
      }
      if (fault === "oversized") tree.tree[0].size = 5_000_001;
      if (fault === "duplicate") tree.tree.push(tree.tree[0]);
      if (fault === "traversal") tree.tree[1].path = "skills/demo/../secret";
      if (fault === "missing") tree.tree.shift();
      return Response.json(tree);
    };
    await expect(
      fetchGitHubSkill(
        {
          repository: "https://github.com/example/skills",
          path: "skills/demo",
        },
        client,
      ),
    ).rejects.toThrow();
    expect(f.requests.some((p) => p.includes("/git/blobs/"))).toBe(false);
  });
  it("rejects blob contents that do not match their Git object hash", async () => {
    const f = github();
    const client: typeof fetch = async (url, init) =>
      String(url).includes("/git/blobs/")
        ? Response.json({
            encoding: "base64",
            content: Buffer.from("corrupt").toString("base64"),
          })
        : f.client(url, init);
    await expect(
      fetchGitHubSkill(
        {
          repository: "https://github.com/example/skills",
          path: "skills/demo",
        },
        client,
      ),
    ).rejects.toThrow("integrity");
  });
  it("fails on rate limiting without following another URL", async () => {
    await expect(
      fetchGitHubSkill(
        { repository: "https://github.com/example/skills" },
        async () => new Response("", { status: 429 }),
      ),
    ).rejects.toThrow("429");
  });
});
