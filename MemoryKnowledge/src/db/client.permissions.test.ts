import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "./client.js";

const isPosix = process.platform !== "win32";
let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const mode = (p: string) => statSync(p).mode & 0o777;

describe.skipIf(!isPosix)("createDb file permissions", () => {
  it("creates the database and WAL sidecars readable by the owner only", () => {
    dir = mkdtempSync(join(tmpdir(), "ks-db-perm-"));
    const path = join(dir, "knowledge.db");
    const prevUmask = process.umask(0o022);
    try {
      const { raw } = createDb({ path });
      raw.prepare("SELECT 1").get();
      expect(mode(path)).toBe(0o600);
      expect(mode(`${path}-wal`)).toBe(0o600);
      expect(mode(`${path}-shm`)).toBe(0o600);
      raw.close();
    } finally {
      process.umask(prevUmask);
    }
  });

  it("tightens an existing world-readable database on open", () => {
    dir = mkdtempSync(join(tmpdir(), "ks-db-perm-"));
    const path = join(dir, "knowledge.db");
    createDb({ path }).raw.close();
    chmodSync(path, 0o644);
    const { raw } = createDb({ path });
    expect(mode(path)).toBe(0o600);
    raw.close();
  });
});
