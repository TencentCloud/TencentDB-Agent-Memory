/**
 * Tests for #779 — exporting the "skill" asset: head rows from the skills
 * table in vectors.db plus per-skill resource files.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import JSZip from "jszip";

import { buildExportBundle } from "../../scripts/export-memory/export-memory.js";

describe("buildExportBundle skill asset (#779)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "tdai-skill-"));
    mkdirSync(join(dataDir, "conversations"), { recursive: true });
    writeFileSync(join(dataDir, "conversations", "2026-08-01.jsonl"), '{"role":"user","content":"hi"}\n');

    // Build a vectors.db with a `skills` table (mirrors SKILLS_DDL head fields).
    const db = new DatabaseSync(join(dataDir, "vectors.db"));
    db.exec(`
      CREATE TABLE skills (
        row_id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        is_head INTEGER NOT NULL DEFAULT 1,
        user_id TEXT NOT NULL,
        owner_agent_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        task_id TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        manifest_json TEXT NOT NULL DEFAULT '[]',
        storage_dir TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )
    `);
    db.prepare(`
      INSERT INTO skills (row_id, skill_id, version, is_head, user_id, owner_agent_id,
        team_id, task_id, name, description, content, content_hash, manifest_json,
        storage_dir, status, metadata_json, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, 1, 'u', 'a', 't', '', 'review-skill', 'desc',
        'do a code review', 'hash1', '[]', ?, 'active', '{}', 1, 1)
    `).run("r1", "skill-1", 1, join(dataDir, "skill-res"));

    // Resource file for the skill.
    mkdirSync(join(dataDir, "skill-res"), { recursive: true });
    writeFileSync(join(dataDir, "skill-res", "prompt.md"), "# review skill prompt");
    db.close();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("exports the skill asset with skills.jsonl + resources + manifest", async () => {
    const { manifest, zip } = await buildExportBundle({ dataDir, assets: ["skill"] });

    const skillAsset = manifest.assets.find((a) => a.type === "skill");
    expect(skillAsset).toBeDefined();
    expect(skillAsset!.files.some((f) => f.path === "skills.jsonl")).toBe(true);
    expect(skillAsset!.files.some((f) => f.path.startsWith("skills/resources/"))).toBe(true);

    const z = await JSZip.loadAsync(zip);
    expect(z.file("skills.jsonl")).toBeTruthy();
    expect(z.file("manifest.json")).toBeTruthy();
    const skillsText = await z.file("skills.jsonl")!.async("string");
    const row = JSON.parse(skillsText.split("\n")[0]);
    expect(row.name).toBe("review-skill");
  });

  it("exports chat-memory and skill together when assets default to all", async () => {
    const { manifest } = await buildExportBundle({ dataDir });
    const types = manifest.assets.map((a) => a.type);
    expect(types).toContain("chat-memory");
    expect(types).toContain("skill");
  });
});
