/**
 * Tests for #779 — MemoryKnowledge-side export of llm-wiki / code-graph
 * assets into a portable ZIP bundle.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import JSZip from "jszip";

import { buildKnowledgeBundle } from "../../scripts/export-knowledge/export-knowledge.js";

describe("buildKnowledgeBundle (#779)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "tdai-kb-"));
    const db = new DatabaseSync(join(dataDir, "knowledge.db"));

    db.exec(`
      CREATE TABLE knowledge_wiki (
        wiki_id TEXT PRIMARY KEY, service_id TEXT NOT NULL, team_id TEXT NOT NULL,
        name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
      );
      CREATE TABLE knowledge_code_graph (
        code_graph_id TEXT PRIMARY KEY, service_id TEXT NOT NULL, team_id TEXT NOT NULL,
        repo_url TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
      );
    `);
    db.prepare(
      "INSERT INTO knowledge_wiki (wiki_id, service_id, team_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, 't', 't')",
    ).run("wiki-1", "svc", "team-x", "onboarding");

    // wiki material dir: dataDir/<service_id>/<team_id>/<wiki_id>/
    const wikiDir = join(dataDir, "svc", "team-x", "wiki-1");
    mkdirSync(wikiDir, { recursive: true });
    writeFileSync(join(wikiDir, "index.db"), "fake-index");
    writeFileSync(join(wikiDir, "onboarding.md"), "# Onboarding guide");

    // code-graph row + dir
    db.prepare(
      "INSERT INTO knowledge_code_graph (code_graph_id, service_id, team_id, repo_url, created_at, updated_at) VALUES (?, ?, ?, ?, 't', 't')",
    ).run("cg-1", "svc", "team-x", "https://example.com/repo");
    const cgDir = join(dataDir, "svc", "team-x", "cg-1");
    mkdirSync(join(cgDir, "symbols"), { recursive: true });
    writeFileSync(join(cgDir, "symbols", "a.json"), "{}");

    db.close();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("exports llm-wiki + code-graph with metadata and material", async () => {
    const { manifest, zip } = await buildKnowledgeBundle({ dataDir, instanceId: "inst" });

    const types = manifest.assets.map((a) => a.type);
    expect(types).toContain("llm-wiki");
    expect(types).toContain("code-graph");

    const wiki = manifest.assets.find((a) => a.type === "llm-wiki")!;
    expect(wiki.files.some((f) => f.path === "knowledge_wiki.jsonl")).toBe(true);
    expect(wiki.files.some((f) => f.path.endsWith("wiki/svc/team-x/wiki-1/onboarding.md"))).toBe(true);
    expect(wiki.files.some((f) => f.path.endsWith("wiki/svc/team-x/wiki-1/index.db"))).toBe(true);

    const cg = manifest.assets.find((a) => a.type === "code-graph")!;
    expect(cg.files.some((f) => f.path.endsWith("code-graph/svc/team-x/cg-1/symbols/a.json"))).toBe(true);

    const z = await JSZip.loadAsync(zip);
    expect(z.file("manifest.json")).toBeTruthy();
    const jsonl = await z.file("knowledge_wiki.jsonl")!.async("string");
    expect(JSON.parse(jsonl.split("\n")[0]).name).toBe("onboarding");
  });

  it("exports only the requested asset kind", async () => {
    const { manifest } = await buildKnowledgeBundle({ dataDir, assets: ["llm-wiki"] });
    expect(manifest.assets.map((a) => a.type)).toEqual(["llm-wiki"]);
  });
});
