import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Skill } from "./types.js";
import { SkillDraftSession } from "./skill-draft-session.js";
import { createSkillDraftTools } from "./skill-draft-tools.js";

const BODY = "---\nname: safe-diagnosis\ndescription: Diagnose safely.\n---\n# Safe diagnosis\nNever delete data without explicit approval.\nCheck logs before changing configuration.\n";
function source(overrides: Partial<Skill> = {}): Skill {
  return { row_id: "row", skill_id: "skl-source", version: 3, is_head: true,
    user_id: "original-author", owner_agent_id: "agent", team_id: "team", task_id: "old-task",
    name: "safe-diagnosis", description: "Diagnose safely.", content: BODY, content_hash: "hash",
    manifest: [{ path: "scripts/check.sh", size_bytes: 18, mime_type: "text/x-shellscript", is_executable: true },
      { path: "assets/icon.bin", size_bytes: 3, mime_type: "application/octet-stream", is_executable: false }],
    storage_dir: "source-dir", status: "active", metadata_json: JSON.stringify({ custom: { untouched: true } }), created_at_ms: 1, updated_at_ms: 2,
    ...overrides };
}
function harness(row = source()) {
  const bytes: Record<string, Buffer> = { "scripts/check.sh": Buffer.from("#!/bin/sh\nprintf x"), "assets/icon.bin": Buffer.from([0, 255, 128]) };
  for (const entry of row.manifest) entry.size_bytes = bytes[entry.path].length;
  const writes = vi.fn(() => { throw new Error("formal writes are forbidden"); });
  const core = {
    get: vi.fn(async () => row),
    list: vi.fn(async () => ({ items: [row], total: 1 })),
    search: vi.fn(async () => [{ skill: row, score: 1 }]),
    readFile: vi.fn(async (input: { path: string; version?: number }) => ({ path: input.path, content: bytes[input.path].toString("base64"), encoding: "base64" as const, size_bytes: bytes[input.path].length, mime_type: "wrong/backend-mime", version: input.version! })),
    create: writes, update: writes, patch: writes, writeFiles: writes,
  };
  const session = new SkillDraftSession({ core, request_id: "batch-1", user_id: "actor", team_id: "team", agent_id: "agent", task_id: "task" });
  const tools = createSkillDraftTools(session);
  async function call(name: string, args: unknown): Promise<any> {
    const t = tools[name] as { execute: (args: unknown, ctx: unknown) => Promise<string> };
    return JSON.parse(await t.execute(args, { toolCallId: "test", messages: [] }));
  }
  return { row, core, writes, session, call, bytes };
}

describe("private extraction draft session", () => {
  it("writes only a private revision and preserves complete source resources, attributes, metadata and ownership", async () => {
    const h = harness();
    const opened = await h.call("skill_view", { skill_id: "skl-source" });
    expect(opened).toMatchObject({ draft_revision: 0, base_version: 3, read_only: false });
    expect(opened.draft_id).toMatch(/^draft:/); expect(opened.version).toBeUndefined();
    const updated = await h.call("skill_update", { draft_id: opened.draft_id, expected_revision: 0, content: BODY + "\nVerify recovery before exiting.\n" });
    expect(updated).toMatchObject({ ok: true, draft_revision: 1 });
    expect(h.row.content).toBe(BODY); expect(h.writes).not.toHaveBeenCalled();
    const batch = await h.session.finalize();
    expect(batch.candidates).toHaveLength(1);
    expect(batch.candidates[0]).toMatchObject({ user_id: "actor", team_id: "team", agent_id: "agent", task_id: "task", source: { skill_id: "skl-source", expected_version: 3 }, candidate: { metadata: { custom: { untouched: true } } } });
    expect(batch.candidates[0].candidate.resources).toEqual([
      { path: "scripts/check.sh", content: h.bytes["scripts/check.sh"].toString("base64"), encoding: "base64", mime_type: "text/x-shellscript", is_executable: true },
      { path: "assets/icon.bin", content: "AP+A", encoding: "base64", mime_type: "application/octet-stream", is_executable: false },
    ]);
    expect(h.core.readFile.mock.calls.every(([input]) => input.version === 3)).toBe(true);
  });
  it("rejects stale revisions and permits self-correction without touching a live version", async () => {
    const h = harness(); const opened = await h.call("skill_view", { skill_id: "skl-source" });
    await h.call("skill_patch", { draft_id: opened.draft_id, expected_revision: 0, old_string: "Check logs", new_string: "Inspect logs" });
    const stale = await h.call("skill_update", { draft_id: opened.draft_id, expected_revision: 0, content: BODY });
    expect(stale.error).toBe("DRAFT_REVISION_CONFLICT");
    expect((await h.call("skill_view", { draft_id: opened.draft_id })).draft_revision).toBe(1);
    expect((await h.call("skill_update", { draft_id: opened.draft_id, expected_revision: 1, content: BODY })).ok).toBe(true);
  });
  it("requires complete body coverage before overwrite and does not truncate stored candidates over 50k", async () => {
    const h = harness(source({ content: BODY + "Evidence and safety remain relevant.\n".repeat(1800) }));
    const opened = await h.call("skill_view", { skill_id: "skl-source", length: 64 });
    expect(opened.content.length).toBeLessThanOrEqual(64); expect(opened.next_offset).toBeGreaterThan(0);
    expect((await h.call("skill_update", { draft_id: opened.draft_id, expected_revision: 0, content: BODY })).error).toBe("DRAFT_BODY_UNREAD");
    const unchanged = await h.session.finalize();
    expect(unchanged.candidates[0].candidate.content).toBe(h.row.content);
    expect(unchanged.candidates[0].candidate.content.length).toBeGreaterThan(50_000);
    const fresh = harness();
    const created = await fresh.call("skill_create", { name: "safe-diagnosis", content: h.row.content });
    expect(created).toMatchObject({ ok: true, draft_revision: 0 }); expect(created.skill_id).toBeUndefined();
    expect((await fresh.session.finalize()).candidates[0].source).toBeUndefined();
  });
  it("loads resources lazily at the fixed base version and requires all bytes before overwrite", async () => {
    const h = harness(); const opened = await h.call("skill_view", { skill_id: "skl-source" });
    expect(h.core.readFile).not.toHaveBeenCalled();
    const args = { draft_id: opened.draft_id, expected_revision: 0, path: "scripts/check.sh", content: "#!/bin/sh\nprintf updated", encoding: "utf-8" };
    expect((await h.call("skill_files_write", args)).error).toBe("DRAFT_RESOURCE_UNREAD");
    const part = await h.call("skill_files_read", { draft_id: opened.draft_id, path: args.path, length: 4 });
    expect(part.next_offset).toBe(4); expect(part.base_version).toBe(3);
    expect((await h.call("skill_files_write", args)).error).toBe("DRAFT_RESOURCE_UNREAD");
    await h.call("skill_files_read", { draft_id: opened.draft_id, path: args.path });
    expect((await h.call("skill_files_write", args)).draft_revision).toBe(1);
    const resource = (await h.session.finalize()).candidates[0].candidate.resources[0];
    expect(resource).toMatchObject({ mime_type: "text/x-shellscript", is_executable: true, content: args.content });
    expect(h.core.readFile.mock.calls.filter(([input]) => input.path === args.path)).toHaveLength(1);
  });
  it.each(["protected", "not-owner", "external"])("allows browsing %s sources but skips them at finalization", async kind => {
    const row = source(kind === "not-owner" ? { owner_agent_id: "someone-else" } : kind === "external" ? { metadata_json: '{"source":"external"}' } : { content: BODY.replace("description: Diagnose safely.", "description: Diagnose safely.\nprotected: true") });
    const h = harness(row); const opened = await h.call("skill_view", { skill_id: row.skill_id });
    expect(opened.read_only).toBe(true); expect(opened.content).toContain("Never delete");
    expect((await h.call("skill_files_read", { draft_id: opened.draft_id, path: "scripts/check.sh" })).content).toContain("printf");
    expect((await h.call("skill_update", { draft_id: opened.draft_id, expected_revision: 0, content: BODY })).error).toBe("DRAFT_READ_ONLY");
    expect((await h.session.finalize()).candidates).toEqual([]);
    expect(h.writes).not.toHaveBeenCalled();
  });
  it("does not turn listings into candidates and includes viewed unchanged owned sources", async () => {
    const h = harness(); await h.call("skill_list", {});
    expect((await h.session.finalize()).candidates).toEqual([]);
    const viewed = harness(); await viewed.call("skill_view", { skill_id: "skl-source" });
    const candidate = (await viewed.session.finalize()).candidates[0];
    expect(candidate.candidate.content).toBe(BODY);
  });
  it("does not change fixed body/version or manifest metadata merely by reading a resource", async () => {
    const h = harness();
    const checksum = createHash("sha256").update(h.bytes["scripts/check.sh"]).digest("hex");
    Object.assign(h.row.manifest[0], { content_sha256: checksum });
    const opened = await h.call("skill_view", { skill_id: "skl-source" });
    h.row.version = 4; h.row.content = BODY + "New live head";
    await h.call("skill_files_read", { draft_id: opened.draft_id, path: "scripts/check.sh" });
    const reread = await h.call("skill_view", { skill_id: "skl-source" });
    expect(reread).toMatchObject({ base_version: 3, draft_revision: 0, content: BODY });
    expect(reread.manifest[0].content_sha256).toBe(checksum);
    expect((await h.call("skill_view", { skill_id: "skl-source", version: 4 })).error).toBe("DRAFT_BASE_VERSION_CONFLICT");
    expect(h.core.get).toHaveBeenCalledTimes(1);
    expect((await h.session.finalize()).candidates[0].source?.expected_version).toBe(3);
  });
  it("bounds draft count rather than silently growing an unbounded private batch", async () => {
    const h = harness();
    for (let i = 0; i < 32; i++) {
      const name = `capability-${i}`;
      expect((await h.call("skill_create", { name, content: BODY.replace("name: safe-diagnosis", `name: ${name}`) })).ok).toBe(true);
    }
    expect((await h.call("skill_create", { name: "overflow", content: BODY.replace("name: safe-diagnosis", "name: overflow") })).error).toBe("DRAFT_LIMIT");
  });
  it("reads complete UTF-8 pages without splitting characters and permits overwrite only after coverage", async () => {
    const h = harness(source({ content: BODY + "汉🙂".repeat(1000) }));
    let page = await h.call("skill_view", { skill_id: "skl-source", length: 101 });
    const id = page.draft_id; let complete = page.content;
    while (page.next_offset !== null) { page = await h.call("skill_view", { draft_id: id, offset: page.next_offset, length: 101 }); complete += page.content; }
    expect(complete).toBe(h.row.content);
    expect((await h.call("skill_update", { draft_id: id, expected_revision: 0, content: BODY })).ok).toBe(true);
  });
  it("rejects corrupted fixed-version resource bytes before a candidate is frozen", async () => {
    const h = harness(); Object.assign(h.row.manifest[0], { content_sha256: "0".repeat(64) });
    const opened = await h.call("skill_view", { skill_id: "skl-source" });
    expect((await h.call("skill_files_read", { draft_id: opened.draft_id, path: "scripts/check.sh" })).error).toBe("DRAFT_RESOURCE_INTEGRITY");
    await expect(h.session.finalize()).rejects.toMatchObject({ code: "DRAFT_RESOURCE_INTEGRITY" });
    expect(h.writes).not.toHaveBeenCalled();
  });
  it("stages new binary resources without falsely decoding them as text", async () => {
    const h = harness(); const created = await h.call("skill_create", { name: "safe-diagnosis", content: BODY, metadata: { workflow_status: "draft:pending" } });
    expect((await h.call("skill_files_write", { draft_id: created.draft_id, expected_revision: 0, path: "assets/new.bin", content: "AP+A", encoding: "base64" })).ok).toBe(true);
    const result = await h.session.finalize();
    expect(result.candidates[0].candidate.resources[0]).toMatchObject({ content: "AP+A", encoding: "base64", mime_type: "application/octet-stream", is_executable: false });
    expect(result.candidates[0].candidate.metadata?.workflow_status).toBe("draft:pending");
  });
  it("does not expose unbounded source manifest attributes in a paged view", async () => {
    const h = harness(); h.row.manifest[0].mime_type = "x".repeat(257);
    const result = await h.call("skill_view", { skill_id: "skl-source" });
    expect(result.error).toBe("DRAFT_RESOURCE_INTEGRITY"); expect(result.content).toBeUndefined();
    expect((await h.session.finalize()).candidates).toEqual([]);
  });
  it("rejects private draft IDs in final package content", async () => {
    const h = harness(); const created = await h.call("skill_create", { name: "safe-diagnosis", content: BODY });
    await h.call("skill_update", { draft_id: created.draft_id, expected_revision: 0, content: `${BODY}\nRead ${created.draft_id}.` });
    await expect(h.session.finalize()).rejects.toMatchObject({ code: "DRAFT_PRIVATE_REFERENCE" });
    const binary = harness(); const asset = await binary.call("skill_create", { name: "safe-diagnosis", content: BODY });
    await binary.call("skill_files_write", { draft_id: asset.draft_id, expected_revision: 0, path: "assets/reference.bin", content: Buffer.from(asset.draft_id).toString("base64"), encoding: "base64" });
    await expect(binary.session.finalize()).rejects.toMatchObject({ code: "DRAFT_PRIVATE_REFERENCE" });
  });
});
