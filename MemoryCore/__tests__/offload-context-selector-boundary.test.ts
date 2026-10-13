import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStorageContext, ensureDirs, registerSession, rewriteAllOffloadEntries, parseSessionKey } from "../src/offload/storage.js";
import { OffloadStateManager } from "../src/offload/state-manager.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "offload-context-")); roots.push(root);
  const ctx = createStorageContext(root, "synthetic-agent", "synthetic-session"); await ensureDirs(ctx);
  return { root, ctx };
}
describe("offload context and JSONL selector boundaries", () => {
  it("rejects an agent component escaping the configured root", async () => {
    const f = await fixture(); expect(() => createStorageContext(f.root, "../outside", "valid")).toThrow("Invalid offload storage filename");
  });
  it("rejects a real session component escaping the agent directory", async () => {
    const f = await fixture(); expect(() => createStorageContext(f.root, "valid", "x/../../outside")).toThrow("Invalid offload storage filename");
  });
  it("rejects an invalid real session override without changing the manager context", async () => {
    const f = await fixture(); const manager = new OffloadStateManager(); await manager.init(f.root, "synthetic-agent", "synthetic-session");
    const prior = manager.ctx;
    await expect(manager.switchSession("agent:synthetic-agent:valid", f.root, "x/../../outside")).rejects.toThrow("Invalid offload storage filename");
    expect(manager.ctx).toBe(prior); expect(manager.sessionId).toBe("synthetic-session");
    await expect(fs.access(path.join(f.ctx.dataDir, "sessions-registry.json"))).rejects.toThrow();
  });
  it("does not publish unsafe session paths to the registry", async () => {
    const f = await fixture(); await registerSession(f.ctx, "agent:synthetic-agent:valid", "valid");
    const file = path.join(f.ctx.dataDir, "sessions-registry.json"), before = await fs.readFile(file, "utf8");
    await expect(registerSession(f.ctx, "agent:synthetic-agent:invalid", "x/../../outside")).rejects.toThrow("Invalid offload storage filename");
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });
  it("rejects escaping JSONL source metadata before any rewrite", async () => {
    const f = await fixture(); const outside = path.join(f.root, "outside.jsonl");
    await fs.writeFile(outside, "synthetic-private-outside"); await fs.writeFile(f.ctx.offloadJsonl, "synthetic-prior-session");
    await expect(rewriteAllOffloadEntries(f.ctx, [{ _sourceFile: "../outside.jsonl", tool_call_id: "synthetic" }])).rejects.toThrow("Invalid offload JSONL source filename");
    expect(await fs.readFile(outside, "utf8")).toBe("synthetic-private-outside");
    expect(await fs.readFile(f.ctx.offloadJsonl, "utf8")).toBe("synthetic-prior-session");
  });
  it("rejects using JSONL source metadata to overwrite state.json", async () => {
    const f = await fixture(); await fs.writeFile(f.ctx.stateFile, "synthetic-private-state"); await fs.writeFile(f.ctx.offloadJsonl, "synthetic-prior-session");
    await expect(rewriteAllOffloadEntries(f.ctx, [{ _sourceFile: "state.json", tool_call_id: "synthetic" }])).rejects.toThrow("Invalid offload JSONL source filename");
    expect(await fs.readFile(f.ctx.stateFile, "utf8")).toBe("synthetic-private-state");
    expect(await fs.readFile(f.ctx.offloadJsonl, "utf8")).toBe("synthetic-prior-session");
  });
  it("retains Unicode contexts, valid registries, worker parsing and JSONL rewrite", async () => {
    const f = await fixture(); const ctx = createStorageContext(f.root, "agent-żółć", "session-é"); await ensureDirs(ctx);
    expect(Object.isFrozen(ctx)).toBe(true); await registerSession(ctx, "agent:agent-żółć:session-é", "session-é");
    expect(JSON.parse(await fs.readFile(path.join(ctx.dataDir, "sessions-registry.json"), "utf8"))["agent:agent-żółć:session-é"].sessionId).toBe("session-é");
    const filename = path.basename(ctx.offloadJsonl); await rewriteAllOffloadEntries(ctx, [{ _sourceFile: filename, tool_call_id: "synthetic" }]);
    expect(JSON.parse(await fs.readFile(ctx.offloadJsonl, "utf8"))).toEqual({ tool_call_id: "synthetic" });
    expect(parseSessionKey("agent:main:swebench-w2:session")).toEqual({ agentName: "main-w2", sessionId: "swebench-w2_session" });
  });
});
