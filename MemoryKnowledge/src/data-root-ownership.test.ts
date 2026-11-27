import { afterEach, describe, expect, it } from "vitest";
import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { acquireDataRootOwnership, acquireKnowledgeStoreOwnership } from "./data-root-ownership.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("CodeGraph data root ownership", () => {
  it("rejects a second owner and allows another after release", () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-owner-"));
    roots.push(root);
    const owner = acquireDataRootOwnership(root);
    try {
      expect(() => acquireDataRootOwnership(root)).toThrow(/already owned/);
    } finally {
      owner.release();
      owner.release();
    }
    const next = acquireDataRootOwnership(root);
    next.release();
  });

  it("releases the lock after an owning process is killed", async () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-owner-crash-"));
    roots.push(root);
    const child = spawn(process.execPath, ["-e", `
      const Database = require("better-sqlite3");
      const db = new Database(process.argv[1], { timeout: 0 });
      db.exec("BEGIN IMMEDIATE");
      process.stdout.write("locked\\n");
      setInterval(() => {}, 1000);
    `, join(root, ".memoryknowledge-owner.sqlite")], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    try {
      await once(child.stdout!, "data");
      expect(() => acquireDataRootOwnership(root)).toThrow(/already owned/);
    } finally {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    const recovered = acquireDataRootOwnership(root);
    recovered.release();
  });

  it("rejects two distinct data roots that share one metadata database", () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-shared-db-"));
    roots.push(root);
    const dbPath = join(root, "shared.sqlite");
    const first = acquireKnowledgeStoreOwnership(join(root, "first"), dbPath);
    try {
      expect(() => acquireKnowledgeStoreOwnership(join(root, "second"), dbPath)).toThrow(/metadata DB.*already owned/);
    } finally {
      first.release();
    }
    const second = acquireKnowledgeStoreOwnership(join(root, "second"), dbPath);
    second.release();
  });

  it("rejects a dangling metadata DB symlink before acquiring ownership", () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-symlink-db-"));
    roots.push(root);
    const target = join(root, "actual.sqlite");
    const alias = join(root, "alias.sqlite");
    symlinkSync(target, alias);

    expect(() => acquireKnowledgeStoreOwnership(join(root, "first"), alias)).toThrow(/symbolic link/);
    // A failed attempt must release the data-root lock as well.
    const owner = acquireKnowledgeStoreOwnership(join(root, "first"), target);
    owner.release();
  });

  it("rejects a hard-linked metadata DB alias that would bypass the owner lock", () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-hardlink-db-"));
    roots.push(root);
    const dbPath = join(root, "shared.sqlite");
    const alias = join(root, "alias.sqlite");
    writeFileSync(dbPath, "");
    linkSync(dbPath, alias);

    expect(() => acquireKnowledgeStoreOwnership(join(root, "first"), dbPath)).toThrow(/hard-linked/);
    expect(() => acquireKnowledgeStoreOwnership(join(root, "second"), alias)).toThrow(/hard-linked/);
    // Neither failure may leave the data-root lock held.
    const owner = acquireDataRootOwnership(join(root, "first"));
    owner.release();
  });
});
