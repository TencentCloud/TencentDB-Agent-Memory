import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createStorageContext, isoToFilename, writeRefMd, readRefMd } from "./storage.js";

describe("storage security (CWE-22)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "offload-sec-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("isoToFilename strips path separators and dotdot", () => {
    expect(isoToFilename("../../../etc/passwd")).not.toMatch(/[/\\]|\.\./);
    expect(isoToFilename("../../../etc/passwd")).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("isoToFilename returns non-empty fallback", () => {
    expect(isoToFilename("")).toBe("ref");
    expect(isoToFilename("///")).toBe("ref");
  });

  it("isoToFilename caps length", () => {
    expect(isoToFilename("a".repeat(500)).length).toBeLessThanOrEqual(128);
  });

  it("writeRefMd writes inside refsDir with normal timestamp", async () => {
    const ctx = createStorageContext(root, "agent1", "sess1");
    mkdirSync(ctx.refsDir, { recursive: true });
    const rel = await writeRefMd(ctx, "2024-01-02T03:04:05.678Z", "tool", "hello");
    expect(rel.startsWith("refs/")).toBe(true);
    expect(existsSync(join(ctx.refsDir, rel.slice("refs/".length)))).toBe(true);
  });

  it("writeRefMd cannot escape refsDir even with malicious timestamp", async () => {
    const ctx = createStorageContext(root, "agent1", "sess1");
    mkdirSync(ctx.refsDir, { recursive: true });
    const rel = await writeRefMd(ctx, "../../evil", "tool", "x");
    // filename must be inside refs/, no escape
    expect(rel).toMatch(/^refs\/[A-Za-z0-9_-]+\.md$/);
    expect(existsSync(join(root, "evil.md"))).toBe(false);
  });

  it("readRefMd returns null on traversal attempts", async () => {
    const ctx = createStorageContext(root, "agent1", "sess1");
    mkdirSync(ctx.dataDir, { recursive: true });
    // Plant a secret outside dataDir
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "TOPSECRET");
    const res = await readRefMd(ctx, "../secret.txt");
    expect(res).toBeNull();
  });

  it("readRefMd reads legitimate ref", async () => {
    const ctx = createStorageContext(root, "agent1", "sess1");
    mkdirSync(ctx.refsDir, { recursive: true });
    const rel = await writeRefMd(ctx, "2024-01-02T03:04:05.678Z", "tool", "payload");
    const content = await readRefMd(ctx, rel);
    expect(content).toContain("payload");
  });

  it("prefix-confusion (sibling dir with same prefix) is blocked", async () => {
    // dataDir is <root>/agent1; a sibling <root>/agent1evil must not be accepted.
    const ctx = createStorageContext(root, "agent1", "sess1");
    mkdirSync(ctx.dataDir, { recursive: true });
    const sibling = join(root, "agent1evil");
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "x.md"), "nope");
    const res = await readRefMd(ctx, `..${sep}agent1evil${sep}x.md`);
    expect(res).toBeNull();
  });
});
