/**
 * Shared contract test suite for IStorageBackend implementations.
 *
 * Every backend (local, cos, git, ...) must satisfy this suite. Import and
 * call `runStorageBackendContractTests()` from a real `*.test.ts` file — this
 * file has no `.test.ts` suffix on purpose so vitest's `include` glob does
 * not try to run it directly (it has no backend to test against on its own).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IStorageBackend } from "../types.js";

export interface ContractTestContext {
  backend: IStorageBackend;
  /** Called after every test to release backend-specific resources (tmpdirs, clones, locks). */
  teardown?: () => Promise<void>;
}

/**
 * Register the shared IStorageBackend contract suite under `describe(name, ...)`.
 * `setup` must return a *fresh* backend instance per call — tests assume no
 * state leaks between them.
 */
export function runStorageBackendContractTests(
  name: string,
  setup: () => Promise<ContractTestContext> | ContractTestContext,
): void {
  describe(`IStorageBackend contract: ${name}`, () => {
    let ctx: ContractTestContext;

    beforeEach(async () => {
      ctx = await setup();
    });

    afterEach(async () => {
      await ctx.teardown?.();
    });

    // ── putObject / getObject ──────────────────────────────────────────

    it("putObject then getObject returns the same content", async () => {
      await ctx.backend.putObject("scene_blocks/work.md", "hello world");
      const obj = await ctx.backend.getObject("scene_blocks/work.md");
      expect(obj).not.toBeNull();
      expect(obj!.content.toString("utf-8")).toBe("hello world");
      expect(obj!.key).toBe("scene_blocks/work.md");
    });

    it("putObject accepts Buffer content", async () => {
      const buf = Buffer.from([0x00, 0x01, 0xff]);
      await ctx.backend.putObject("records/binary.bin", buf);
      const obj = await ctx.backend.getObject("records/binary.bin");
      expect(obj!.content.equals(buf)).toBe(true);
    });

    it("putObject overwrites an existing object", async () => {
      await ctx.backend.putObject("persona.md", "v1");
      await ctx.backend.putObject("persona.md", "v2");
      const obj = await ctx.backend.getObject("persona.md");
      expect(obj!.content.toString("utf-8")).toBe("v2");
    });

    it("getObject returns null for a missing key", async () => {
      const obj = await ctx.backend.getObject("does/not/exist.md");
      expect(obj).toBeNull();
    });

    it("getObject reports size and lastModified", async () => {
      await ctx.backend.putObject("records/2026-08-15.jsonl", "abcde");
      const obj = await ctx.backend.getObject("records/2026-08-15.jsonl");
      expect(obj!.size).toBe(5);
      expect(obj!.lastModified).toBeInstanceOf(Date);
    });

    // ── appendObject ────────────────────────────────────────────────────

    it("appendObject creates the object if it does not exist", async () => {
      await ctx.backend.appendObject("records/2026-08-15.jsonl", "line1\n");
      const obj = await ctx.backend.getObject("records/2026-08-15.jsonl");
      expect(obj!.content.toString("utf-8")).toBe("line1\n");
    });

    it("appendObject adds to the end of an existing object", async () => {
      await ctx.backend.putObject("records/2026-08-15.jsonl", "line1\n");
      await ctx.backend.appendObject("records/2026-08-15.jsonl", "line2\n");
      const obj = await ctx.backend.getObject("records/2026-08-15.jsonl");
      expect(obj!.content.toString("utf-8")).toBe("line1\nline2\n");
    });

    it("sequential appendObject calls preserve order", async () => {
      for (let i = 0; i < 5; i++) {
        await ctx.backend.appendObject("records/seq.jsonl", `${i}\n`);
      }
      const obj = await ctx.backend.getObject("records/seq.jsonl");
      expect(obj!.content.toString("utf-8")).toBe("0\n1\n2\n3\n4\n");
    });

    // ── exists ───────────────────────────────────────────────────────────

    it("exists returns false for a missing key and true after put", async () => {
      expect(await ctx.backend.exists("scene_blocks/x.md")).toBe(false);
      await ctx.backend.putObject("scene_blocks/x.md", "x");
      expect(await ctx.backend.exists("scene_blocks/x.md")).toBe(true);
    });

    // ── deleteObject ─────────────────────────────────────────────────────

    it("deleteObject removes the object", async () => {
      await ctx.backend.putObject("scene_blocks/x.md", "x");
      await ctx.backend.deleteObject("scene_blocks/x.md");
      expect(await ctx.backend.exists("scene_blocks/x.md")).toBe(false);
    });

    it("deleteObject on a missing key is idempotent (no throw)", async () => {
      await expect(ctx.backend.deleteObject("does/not/exist.md")).resolves.toBeUndefined();
    });

    // ── listObjects ──────────────────────────────────────────────────────

    it("listObjects returns entries under a prefix", async () => {
      await ctx.backend.putObject("scene_blocks/a.md", "a");
      await ctx.backend.putObject("scene_blocks/b.md", "b");
      const result = await ctx.backend.listObjects("scene_blocks/");
      const keys = result.entries.map((e) => e.key).sort();
      expect(keys).toEqual(["scene_blocks/a.md", "scene_blocks/b.md"]);
    });

    it("listObjects on a missing prefix returns an empty result", async () => {
      const result = await ctx.backend.listObjects("nowhere/");
      expect(result.entries).toEqual([]);
    });

    it("listObjects respects maxKeys and paginates via nextMarker", async () => {
      for (let i = 0; i < 5; i++) {
        await ctx.backend.putObject(`scene_blocks/${i}.md`, String(i));
      }
      const page1 = await ctx.backend.listObjects("scene_blocks/", { maxKeys: 2 });
      expect(page1.entries).toHaveLength(2);
      expect(page1.nextMarker).toBeDefined();

      const page2 = await ctx.backend.listObjects("scene_blocks/", {
        maxKeys: 2,
        marker: page1.nextMarker,
      });
      expect(page2.entries).toHaveLength(2);
      expect(page2.entries[0]!.key).not.toBe(page1.entries[0]!.key);

      const seen = new Set([...page1.entries, ...page2.entries].map((e) => e.key));
      expect(seen.size).toBe(4); // two pages of 2, no overlap
    });

    it("listObjects with recursive:false does not descend into subdirectories", async () => {
      await ctx.backend.putObject("conversations/2026-08-15.jsonl", "a");
      await ctx.backend.putObject("conversations/nested/deep.jsonl", "b");
      const result = await ctx.backend.listObjects("conversations/", { recursive: false });
      const keys = result.entries.map((e) => e.key);
      expect(keys).toContain("conversations/2026-08-15.jsonl");
      expect(keys.some((k) => k.includes("deep.jsonl"))).toBe(false);
    });

    it("listObjects with recursive:true descends into subdirectories", async () => {
      await ctx.backend.putObject("conversations/2026-08-15.jsonl", "a");
      await ctx.backend.putObject("conversations/nested/deep.jsonl", "b");
      const result = await ctx.backend.listObjects("conversations/", { recursive: true });
      const keys = result.entries.map((e) => e.key);
      expect(keys.some((k) => k.endsWith("deep.jsonl"))).toBe(true);
    });

    // ── deleteByPrefix ───────────────────────────────────────────────────

    it("deleteByPrefix removes all objects under a prefix and returns the count", async () => {
      await ctx.backend.putObject("scene_blocks/a.md", "a");
      await ctx.backend.putObject("scene_blocks/b.md", "b");
      await ctx.backend.putObject("scene_blocks/nested/c.md", "c");
      const count = await ctx.backend.deleteByPrefix("scene_blocks/");
      expect(count).toBe(3);
      expect((await ctx.backend.listObjects("scene_blocks/", { recursive: true })).entries).toEqual([]);
    });

    it("deleteByPrefix on a missing prefix returns 0", async () => {
      const count = await ctx.backend.deleteByPrefix("nowhere/");
      expect(count).toBe(0);
    });

    // ── path traversal / key validation ─────────────────────────────────

    const badKeys = [
      ["empty string", ""],
      ["NUL byte", "records/\0evil"],
      ["leading slash (absolute)", "/etc/passwd"],
      ["leading backslash", "\\evil"],
      ["parent traversal", "../../../etc/passwd"],
      ["parent traversal with valid prefix", "scene_blocks/../../../etc/passwd"],
    ] as const;

    for (const [label, key] of badKeys) {
      it(`putObject rejects ${label}`, async () => {
        await expect(ctx.backend.putObject(key, "x")).rejects.toThrow();
      });

      it(`getObject rejects ${label}`, async () => {
        await expect(ctx.backend.getObject(key)).rejects.toThrow();
      });
    }
  });
}
