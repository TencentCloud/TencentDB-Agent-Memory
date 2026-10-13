import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter, buildPage, readSources, mergeSources } from "../src/engines/wiki/ingest-v2/frontmatter.js";
import { mergePage } from "../src/engines/wiki/ingest-v2/merge.js";
import { deleteSourceFiles, cascadeDeleteWikiPagesWithRefs } from "../src/engines/wiki/ingest-v2/cascade.js";
import { rebuildIndexFile } from "../src/engines/wiki/ingest-v2/index-builder.js";
import { readOkfMetadata, okfLinks } from "../src/engines/wiki/okf.js";
import { validateBundle, importBundle, exportBundle } from "../src/engines/wiki/okf-bundle.js";
import { migrateOkfPage } from "../src/engines/wiki/okf-migrate.js";
import { ensureSources, extractSource } from "../src/engines/wiki/ingest-v2/index.js";
import type { LlmClient } from "../src/engines/wiki/ingest-v2/llm.js";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "okf-test-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const page = (fm: Record<string, unknown>, body = "A fact") => buildPage({ type: "concept", ...fm }, body);
const fakeLlm = (out: string) => ({ chat: vi.fn(async () => out), config: {} } as unknown as LlmClient);

describe("OKF consumer and legacy compatibility", () => {
  it("reads object and legacy sources without discarding provenance", () => {
    const text = page({ sources: ["legacy.md", { resource: "https://example.org/a", id: "a", extra: null }] });
    expect(readSources(text)).toEqual(["legacy.md", "https://example.org/a"]);
    expect(parseFrontmatter(buildPage(parseFrontmatter(text).frontmatter, "Body")).frontmatter.sources).toEqual(parseFrontmatter(text).frontmatter.sources);
  });
  it("preserves unknown metadata including null", () => {
    expect(parseFrontmatter(page({ custom: { a: null }, nullable: null })).frontmatter).toMatchObject({ custom: { a: null }, nullable: null });
  });
  it.each(["---\ntype: [bad\n---\nbody", "---\n- one\n---\nbody", "body"])("tolerates malformed or absent frontmatter", (text) => {
    expect(parseFrontmatter(text).hasFrontmatter).toBe(false);
  });
  it("accepts CRLF and custom types", () => {
    expect(parseFrontmatter("---\r\ntype: My Custom Type\r\n---\r\nBody").frontmatter.type).toBe("My Custom Type");
  });
  it.each([
    [{}, "unverified"],
    [{ verified: { by: "process:check", at: "2026-01-01T00:00:00Z" } }, "machine-confirmed"],
    [{ verified: [{ by: "human:adam", at: "2026-01-01T00:00:00Z" }] }, "human-reviewed"],
  ])("derives trust from verification", (fm, trust) => expect(readOkfMetadata(page(fm)).trust).toBe(trust));
  it("does not equate stable status or generated author with verification", () => {
    expect(readOkfMetadata(page({ status: "stable", generated: { by: "human:adam" } })).trust).toBe("unverified");
  });
  it("computes staleness at the boundary and flags verification older than changed content", () => {
    const fm = { stale_after: "2026-10-03T00:00:00Z", generated: { by: "agent/1", at: "2026-10-02T00:00:00Z" }, verified: { by: "human:adam", at: "2026-10-01T00:00:00Z" } };
    expect(readOkfMetadata(page(fm), Date.parse(fm.stale_after))).toMatchObject({ stale: true, verificationPredatesContent: true });
    expect(readOkfMetadata(page(fm), Date.parse(fm.stale_after) - 1).stale).toBe(false);
  });
  it("uses legacy timestamp without inventing an actor", () => {
    const result = migrateOkfPage(page({ timestamp: "2026-01-01T00:00:00Z", locked: true, sources: ["a.md"] }).replace("type: concept", "type: concept\nlocked: true"));
    expect(parseFrontmatter(result.content).frontmatter.generated).toBeUndefined();
    expect(parseFrontmatter(result.content).frontmatter.locked).toBe(true);
    expect(result.warnings).toHaveLength(1);
  });
  it("warns rather than rejects an invalid optional family", () => {
    const metadata = readOkfMetadata(page({ stale_after: "2026-01-01", type: "Attested Computation", sources: [{ resource: "x", id: "a" }, { resource: "y", id: "a" }] }, "Claim[^missing]"));
    expect(metadata.warnings).toContain("Attested Computation requires runtime");
    expect(metadata.warnings).toContain("Duplicate sources[].id; attribution is ambiguous");
    expect(metadata.warnings).toContain("Footnote has no sources[].id: missing");
  });
  it("resolves absolute, relative and provenance concept links; ignores external links and code", () => {
    const text = page({ sources: [{ resource: "/references/a.md" }] }, "[A](/a.md) [B](../b.md#h) ![image](c.md) [Web](https://x/a.md)\n`[code](bad.md)`\n```md\n[code](bad.md)\n```\n");
    expect(okfLinks(text, "nested/page.md")).toEqual(["a", "b", "references/a"]);
  });
  it("supports CommonMark reference links and escaped/encoded paths", () => {
    expect(okfLinks(page({}, "[A][target] and [B](/space%20name.md).\n\n[target]: /a.md\n"), "nested/page.md")).toEqual(["a", "space name"]);
  });
  it("keeps separate source IDs and merges extension metadata", () => {
    expect(mergeSources([{ resource: "x", id: "a", author: "human:x" }], [{ resource: "x", id: "a", title: "X" }, { resource: "x", id: "b" }])).toEqual([{ resource: "x", id: "a", author: "human:x", title: "X" }, { resource: "x", id: "b" }]);
  });
});

describe("merge and cascade retain OKF semantics", () => {
  it("redundant ingestion preserves verification and provenance without LLM", async () => {
    const llm = fakeLlm("");
    const old = page({ sources: [{ resource: "x", id: "s", title: "Source" }], verified: { by: "human:a", at: "2026-01-01T00:00:00Z" }, custom: 1 });
    const result = await mergePage(old, page({ sources: ["legacy.md"] }), llm);
    expect(llm.chat).not.toHaveBeenCalled();
    expect(result.action).toBe("write");
    if (result.action === "write") expect(parseFrontmatter(result.content).frontmatter).toMatchObject({ custom: 1, verified: { by: "human:a" }, sources: [{ id: "s", title: "Source" }, "legacy.md"] });
  });
  it("rewriting cannot fabricate verification or erase unknown old fields", async () => {
    const old = page({ custom: { a: 1 }, sources: [{ resource: "x", id: "s" }] }, "Old");
    const llm = fakeLlm(page({ verified: { by: "human:fake" }, sources: [] }, "Merged"));
    const result = await mergePage(old, page({ sources: ["new.md"] }, "New"), llm);
    if (result.action !== "write") throw new Error("Expected write");
    const fm = parseFrontmatter(result.content).frontmatter;
    expect(fm.custom).toEqual({ a: 1 }); expect(fm.verified).toBeUndefined();
    expect(fm.generated?.by).toBe("wiki-ingest/2"); expect(fm.sources).toHaveLength(2);
  });
  it("does not let LLM merge alter an attested computation contract", async () => {
    const llm = fakeLlm("mutated");
    const result = await mergePage(page({ type: "Attested Computation", runtime: "python" }), page({}, "New"), llm);
    expect(result.action).toBe("skip"); expect(llm.chat).not.toHaveBeenCalled();
  });
  it("fallback preserves both bodies and new extension fields", async () => {
    const result = await mergePage(page({ oldExtension: 1 }, "Old fact"), page({ newExtension: 2 }, "New fact"), fakeLlm("invalid result"));
    if (result.action !== "write") throw new Error("Expected write");
    expect(result.content).toContain("Old fact"); expect(result.content).toContain("New fact");
    expect(parseFrontmatter(result.content).frontmatter).toMatchObject({ oldExtension: 1, newExtension: 2 });
  });
  it("extraction records the full nested raw key for exact cascade deletion", async () => {
    const root = temp(); mkdirSync(join(root, "raw/sources/nested"), { recursive: true });
    const raw = join(root, "raw/sources/nested/a.md"); writeFileSync(raw, "A fact");
    const llm = fakeLlm(`<<<FILE path="wiki/concepts/a.md">>>\n${page({ title: "A" })}<<<END>>>`);
    const candidates = await extractSource(root, raw, {}, [], { llm, mode: "single-stage" });
    const content = [...candidates.values()][0];
    expect(parseFrontmatter(content).frontmatter.sources).toContainEqual({ resource: "raw source: nested/a.md", tdai_raw_source: "nested/a.md" });
  });
  it("generated candidates keep object sources and cannot claim human verification", () => {
    const text = ensureSources(page({ sources: [{ resource: "https://example.org", id: "web" }], verified: { by: "human:fake" } }), "nested/a.md");
    const fm = parseFrontmatter(text).frontmatter;
    expect(fm.verified).toBeUndefined(); expect(fm.sources).toEqual([{ resource: "https://example.org", id: "web" }, { resource: "raw source: nested/a.md", tdai_raw_source: "nested/a.md" }]);
  });
  it("preserves locked pages", async () => {
    const llm = fakeLlm("");
    expect((await mergePage("---\ntype: concept\nlocked: true\n---\nOld", page({}, "New"), llm)).action).toBe("skip");
    expect(llm.chat).not.toHaveBeenCalled();
  });
  it("cascade matches exact raw keys, not external URL basenames", async () => {
    const root = temp(); mkdirSync(join(root, "raw/sources/nested"), { recursive: true }); mkdirSync(join(root, "wiki"));
    writeFileSync(join(root, "raw/sources/nested/a.md"), "raw");
    writeFileSync(join(root, "wiki/shared.md"), page({ sources: [{ resource: "raw source: nested/a.md", tdai_raw_source: "nested/a.md", id: "a" }, { resource: "https://example.org/a.md", id: "web", author: "human:b" }] }));
    await deleteSourceFiles(root, [join(root, "raw/sources/nested/a.md")]);
    const remaining = parseFrontmatter(readFileSync(join(root, "wiki/shared.md"), "utf-8")).frontmatter.sources;
    expect(remaining).toEqual([{ resource: "https://example.org/a.md", id: "web", author: "human:b" }]);
  });
  it("migration is explicit, idempotent and preserves the body and control fields", () => {
    const input = "---\ntype: custom\nlocked: true\nsources: [a.md]\nextra: null\n---\n\n  Body  \n";
    const result = migrateOkfPage(input);
    expect(result.changed).toBe(true); expect(result.content.endsWith("\n\n  Body  \n")).toBe(true);
    expect(parseFrontmatter(result.content).frontmatter).toMatchObject({ locked: true, extra: null, sources: [{ tdai_raw_source: "a.md" }] });
    expect(migrateOkfPage(result.content).changed).toBe(false);
  });
  it("redundant merge preserves candidate's new frontmatter fields", async () => {
    const old = page({ sources: ["old.md"], verified: { by: "old" } }, "Fact");
    const cand = page({ sources: ["new.md"], verified: { by: "new" }, extra: 1 }, "Fact");
    const result = await mergePage(old, cand, fakeLlm(""));
    if (result.action !== "write") throw new Error("Expected write");
    const fm = parseFrontmatter(result.content).frontmatter;
    expect(fm).toMatchObject({ verified: { by: "old" }, extra: 1, sources: ["old.md", "new.md"] });
  });
  it("skips merge completely if either page is an Attested Computation", async () => {
    const attested = page({ type: "Attested Computation" }, "X");
    const normal = page({ type: "concept" }, "Y");
    const llm = fakeLlm("mutated");
    expect((await mergePage(attested, normal, llm)).action).toBe("skip");
    expect((await mergePage(normal, attested, llm)).action).toBe("skip");
    expect(llm.chat).not.toHaveBeenCalled();
  });
  it("cannot add candidate verification through a redundant merge", async () => {
    const result = await mergePage(page({}, "Fact"), page({ verified: { by: "human:forged" }, extra: 1 }, "Fact"), fakeLlm(""));
    if (result.action !== "write") throw new Error("Expected write");
    expect(parseFrontmatter(result.content).frontmatter.verified).toBeUndefined();
    expect(parseFrontmatter(result.content).frontmatter.extra).toBe(1);
  });
});

describe("native bundle exchange", () => {
  const files = () => [
    { path: "index.md", content: '---\nokf_version: "0.2"\n---\n# Index\n\n* [Page](/custom/page.md)\n' },
    { path: "custom/page.md", content: "---\ntype: Custom\nverified: {by: 'human:a', at: '2026-01-01T00:00:00Z'}\nextra: null\n---\n\n Exact body  \n" },
    { path: "references/attester.py", content: "raise Exception('never execute me')\n" },
    { path: "media/image.bin", content: "AAECA/8=", encoding: "base64" as const },
  ];
  it("imports and exports exactly the same bytes, paths and code without executing it", () => {
    const root = temp(); const report = importBundle(join(root, "wiki"), files());
    expect(report.concepts).toBe(1);
    const exported = exportBundle(join(root, "wiki")); const dest = join(temp(), "wiki");
    importBundle(dest, exported);
    for (const file of files()) expect(readFileSync(join(dest, file.path))).toEqual(readFileSync(join(root, "wiki", file.path)));
  });
  it.each(["../x.md", "/x.md", "a/../../x.md", "a\\x.md", ".state/token", "a//x.md", "a/./x.md", "x\0.md"])("rejects unsafe path %s", (path) => {
    expect(() => validateBundle([{ path, content: page({}) }])).toThrow();
  });
  it("retains the existing wiki if staged writes fail on a filesystem collision", () => {
    const root = temp(); const wiki = join(root, "wiki"); mkdirSync(wiki); writeFileSync(join(wiki, "blocked"), "original");
    expect(() => importBundle(wiki, [{ path: "blocked/new.md", content: page({}) }])).toThrow();
    expect(readFileSync(join(wiki, "blocked"), "utf-8")).toBe("original");
  });
  it("preflights the entire bundle before writing anything", () => {
    const root = temp(); const wiki = join(root, "wiki");
    expect(() => importBundle(wiki, [{ path: "good.md", content: page({}) }, { path: "bad.md", content: "no type" }])).toThrow();
    expect(existsSync(wiki)).toBe(false);
  });
  it("rejects YAML lists and duplicate YAML keys", () => {
    expect(() => validateBundle([{ path: "a.md", content: "---\n- item\n---\n" }])).toThrow();
    expect(() => validateBundle([{ path: "a.md", content: "---\ntype: x\ntype: y\n---\n" }])).toThrow();
  });
  it("accepts minimal concepts, unknown fields, broken links and absent indexes", () => {
    expect(validateBundle([{ path: "custom.md", content: "---\ntype: Unknown\nextension: null\n---\n[missing](/missing.md)" }]).concepts).toBe(1);
  });
  it("does not permit frontmatter on a nested index", () => {
    expect(() => validateBundle([{ path: "nested/index.md", content: '---\nokf_version: "0.2"\n---\n' }])).toThrow();
  });
  it("preserves log frontmatter without counting reserved logs as concepts", () => {
    const content = "---\ntype: Log\ntitle: Bundle history\n---\n\n# History\n\n## 2026-07-01\n\n- Reviewed.\n";
    const logs = ["log.md", "nested/log.md"].map((path) => ({ path, content }));
    const wiki = join(temp(), "wiki");
    expect(importBundle(wiki, logs)).toMatchObject({ files: 2, concepts: 0, warnings: [] });
    const exported = exportBundle(wiki);
    const restored = join(temp(), "wiki");
    importBundle(restored, exported);
    for (const { path } of logs) expect(readFileSync(join(restored, path))).toEqual(Buffer.from(content));
  });
  it("future version declaration is advisory", () => {
    const report = validateBundle([{ path: "index.md", content: '---\nokf_version: "99"\n---\n# Index' }]);
    expect(report.warnings).toHaveLength(1);
  });
  it("requires explicit overwrite and protects locked documents", () => {
    const wiki = join(temp(), "wiki"); importBundle(wiki, files());
    expect(() => importBundle(wiki, files())).toThrow("Destination exists");
    importBundle(wiki, files(), true);
    writeFileSync(join(wiki, "custom/page.md"), "---\ntype: custom\nlocked: true\n---\nOld");
    expect(() => importBundle(wiki, files(), true)).toThrow("Locked page");
  });
  it("rejects symlinks in source/destination", () => {
    const root = temp(); mkdirSync(join(root, "wiki")); symlinkSync(temp(), join(root, "wiki/link"));
    expect(() => importBundle(join(root, "wiki"), files())).toThrow("filesystem");
    expect(() => exportBundle(join(root, "wiki"))).toThrow("filesystem");
  });
  it("rejects duplicate paths, alias collisions and file/directory collisions", () => {
    expect(() => validateBundle([...files(), files()[0]])).toThrow("Duplicate");
    expect(() => validateBundle([{ path: "a.md", content: page({}) }, { path: "A.md", content: page({}) }])).toThrow("alias");
    expect(() => validateBundle([{ path: "cafe\u0301.md", content: page({}) }, { path: "caf\u00E9.md", content: page({}) }])).toThrow("alias");
    expect(() => validateBundle([{ path: "a", content: page({}) }, { path: "a/b.md", content: page({}) }])).toThrow("collision");
    expect(() => validateBundle([{ path: "FOO/a.md", content: page({}) }, { path: "foo/b.md", content: page({}) }])).toThrow("Directory alias collision");
  });
  it("rejects invalid base64 and oversized bundles", () => {
    expect(() => validateBundle([{ path: "a.bin", content: "!!!!", encoding: "base64" }])).toThrow("base64");
    expect(() => validateBundle([{ path: "a.bin", content: "x".repeat(10 * 1024 * 1024 + 1) }])).toThrow("10 MiB");
  });
  it("rejects destination collisions across case, unicode normalization and file/dir boundaries", () => {
    const wiki = join(temp(), "wiki"); mkdirSync(join(wiki, "foo"), { recursive: true });
    writeFileSync(join(wiki, "foo", "a.md"), "old");
    writeFileSync(join(wiki, "b.md"), "old");
    // A directory and a differently named Markdown file can coexist.
    expect(() => importBundle(wiki, [{ path: "foo.md", content: page({}) }])).not.toThrow();
    expect(() => importBundle(wiki, [{ path: "foo", content: "attachment" }])).toThrow("directory");
    // b.md is a file, b.md/x is a dir
    expect(() => importBundle(wiki, [{ path: "b.md/x", content: page({}) }])).toThrow("collision");
    // case collision where target file exists but with different case
    for (const overwrite of [false, true]) {
      expect(() => importBundle(wiki, [{ path: "foo/A.md", content: page({}) }], overwrite)).toThrow("Alias collision");
      expect(() => importBundle(wiki, [{ path: "FOO/new.md", content: page({}) }], overwrite)).toThrow("Alias collision");
    }
  });
  it("rebuilds index with version declaration and skips reserved names at every level", () => {
    const root = temp(); mkdirSync(join(root, "wiki/nested"), { recursive: true });
    writeFileSync(join(root, "wiki/nested/page.md"), page({ title: "Page" }));
    writeFileSync(join(root, "wiki/nested/index.md"), "# Index"); writeFileSync(join(root, "wiki/nested/log.md"), "# Log");
    expect(rebuildIndexFile(root)).toBe(1);
    const index = readFileSync(join(root, "wiki/index.md"), "utf-8"); expect(index).toContain('okf_version: "0.2"');
    expect(index).toContain("/nested/page.md"); expect(index).not.toContain("/nested/log.md");
  });
});

describe("cascade deletion", () => {
  it("protects locked and Attested Computation pages from silent rewrite and updates timestamps", async () => {
    const root = temp();
    mkdirSync(join(root, "wiki"), { recursive: true });
    mkdirSync(join(root, "raw", "sources"), { recursive: true });

    writeFileSync(join(root, "raw", "sources", "a.txt"), "hello");

    // Page sharing a deleted source
    writeFileSync(join(root, "wiki", "normal.md"), "---\ntype: custom\nsources:\n  - a.txt\n  - retained.txt\n---\nbody [[target]]");
    writeFileSync(join(root, "wiki", "locked.md"), "---\ntype: custom\nlocked: true\nsources:\n  - a.txt\n---\nbody [[target]]");
    writeFileSync(join(root, "wiki", "attested.md"), "---\ntype: Attested Computation\nsources:\n  - a.txt\n---\nbody [[target]]");

    // Delete source a.txt
    const result1 = await deleteSourceFiles(root, [join(root, "raw", "sources", "a.txt")]);
    expect(result1.rewrittenSourcePages).toBe(1); // Only normal.md should be rewritten

    // normal is rewritten to remove source and has generated timestamp
    const normal = readFileSync(join(root, "wiki", "normal.md"), "utf-8");
    expect(normal).toContain("generated:");
    expect(normal).not.toContain("a.txt");

    // locked is untouched
    expect(readFileSync(join(root, "wiki", "locked.md"), "utf-8")).toContain("a.txt");
    expect(readFileSync(join(root, "wiki", "locked.md"), "utf-8")).not.toContain("generated:");

    // attested is untouched
    expect(readFileSync(join(root, "wiki", "attested.md"), "utf-8")).toContain("a.txt");

    // Test cascade delete wiki page with refs
    writeFileSync(join(root, "wiki", "target.md"), "---\ntype: custom\ntitle: target\n---\n");
    const result2 = await cascadeDeleteWikiPagesWithRefs(root, [join(root, "wiki", "target.md")]);
    expect(result2.rewrittenFiles).toBe(1); // Only normal.md should be rewritten

    const normal2 = readFileSync(join(root, "wiki", "normal.md"), "utf-8");
    expect(normal2).toContain("generated:");
    expect(normal2).toContain("body target");
    expect(normal2).not.toContain("[[target]]");

    const locked2 = readFileSync(join(root, "wiki", "locked.md"), "utf-8");
    expect(locked2).toContain("[[target]]");
    expect(locked2).not.toContain("generated:");

    const attested2 = readFileSync(join(root, "wiki", "attested.md"), "utf-8");
    expect(attested2).toContain("[[target]]");
  });
});
