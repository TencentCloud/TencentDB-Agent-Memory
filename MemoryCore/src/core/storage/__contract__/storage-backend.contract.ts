/**
 * IStorageBackend conformance suite — the normative D9.2 clauses.
 *
 * Every IStorageBackend implementation must pass this identical suite, so that
 * upper layers (scene navigation, /scenario/ls, read tools) behave the same no
 * matter which backend is mounted. The suite exists because Local and COS were
 * found to disagree on four axes while both were already in production
 * (see docs/design/mongodb/design/2026-08-27-core-storage-abstraction-design.md, D9.1).
 *
 * Usage:
 *   runStorageBackendContract("local", async () => ({ backend, cleanup }));
 *
 * `root` lets a backend with a restricted key space (rowfs only serves
 * profile paths) host the suite under a prefix it accepts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { IStorageBackend, ListEntry } from "../types.js";

export interface StorageContractHarness {
  backend: IStorageBackend;
  cleanup?: () => Promise<void>;
}

export interface StorageContractOptions {
  /** Prefix the suite creates its fixtures under. Must be "" or end with "/". */
  root?: string;
  /** Backends that cannot append (rowfs) must reject instead. Default: true. */
  supportsAppend?: boolean;
}

const sortKeys = (entries: ListEntry[]): string[] => entries.map((e) => e.key).sort();

export function runStorageBackendContract(
  name: string,
  createHarness: () => Promise<StorageContractHarness>,
  options: StorageContractOptions = {},
): void {
  const root = options.root ?? "";
  const supportsAppend = options.supportsAppend ?? true;

  if (root !== "" && !root.endsWith("/")) {
    throw new Error(`contract root must be "" or end with "/", got: ${root}`);
  }

  describe(`IStorageBackend contract [${name}]`, () => {
    let backend: IStorageBackend;
    let cleanup: (() => Promise<void>) | undefined;

    /** Fixture layout, deliberately mixing same-level files and nested dirs. */
    const K = {
      alpha: `${root}alpha.md`,
      beta: `${root}beta.md`,
      zeta: `${root}zeta.md`,
      workQ1: `${root}work/q1.md`,
      workQ2: `${root}work/q2.md`,
      workDeep: `${root}work/deep/z.md`,
    };
    const ALL_FILES = Object.values(K).sort();

    beforeEach(async () => {
      const h = await createHarness();
      backend = h.backend;
      cleanup = h.cleanup;
      // alpha carries metadata so backends with sidecar files (Local writes
      // "<key>.meta.json") have one to hide — that is clause 8's fixture.
      await backend.putObject(K.alpha, "# alpha", { metadata: { kind: "l2" } });
      await backend.putObject(K.beta, "# beta");
      await backend.putObject(K.zeta, "# zeta");
      await backend.putObject(K.workQ1, "# q1");
      await backend.putObject(K.workQ2, "# q2");
      await backend.putObject(K.workDeep, "# z");
    });

    afterEach(async () => {
      await cleanup?.();
    });

    // ── Clause 1 ───────────────────────────────────────────────────────────
    it("[1] treats prefix as a string prefix, not a directory", async () => {
      // "…/wo" stops mid-name: a directory-based implementation returns empty.
      const dir = await backend.listObjects(`${root}wo`);
      expect(sortKeys(dir.entries)).toEqual([`${root}work/`]);

      const file = await backend.listObjects(`${root}al`);
      expect(sortKeys(file.entries)).toEqual([K.alpha]);
      expect(file.entries[0].isDirectory).toBe(false);
    });

    // ── Clause 2 ───────────────────────────────────────────────────────────
    it("[2] non-recursive: folds deeper paths into one trailing-slash directory entry", async () => {
      const res = await backend.listObjects(root, { maxKeys: 100 });
      expect(sortKeys(res.entries)).toEqual([K.alpha, K.beta, `${root}work/`, K.zeta].sort());

      const workDir = res.entries.find((e) => e.key === `${root}work/`)!;
      expect(workDir.isDirectory).toBe(true);
      expect(workDir.size).toBe(0);
      // q1/q2/deep collapse into the single "work/" entry above.
      for (const e of res.entries.filter((x) => !x.isDirectory)) {
        expect(e.isDirectory).toBe(false);
      }
    });

    // ── Clause 3 ───────────────────────────────────────────────────────────
    it("[3] recursive: yields files only, never a directory entry", async () => {
      const res = await backend.listObjects(root, { recursive: true, maxKeys: 100 });
      expect(res.entries.every((e) => !e.isDirectory)).toBe(true);
      expect(sortKeys(res.entries)).toEqual(ALL_FILES);
    });

    // ── Clause 4 ───────────────────────────────────────────────────────────
    it("[4] keys are full backend-root-relative keys, directories end with /", async () => {
      const res = await backend.listObjects(`${root}work/`, { maxKeys: 100 });
      // Not re-relativised to "q1.md" / "deep/".
      expect(sortKeys(res.entries)).toEqual([K.workQ1, K.workQ2, `${root}work/deep/`].sort());
      for (const e of res.entries) {
        expect(e.key.startsWith(`${root}work/`)).toBe(true);
        expect(e.key.endsWith("/")).toBe(e.isDirectory);
      }
    });

    // ── Clause 5 ───────────────────────────────────────────────────────────
    it("[5] total equals this page's entry count, not the match count", async () => {
      const res = await backend.listObjects(root, { recursive: true, maxKeys: 2 });
      expect(res.entries).toHaveLength(2);
      expect(res.total).toBe(2);
      expect(res.total).not.toBe(ALL_FILES.length);
    });

    // ── Clause 6 ───────────────────────────────────────────────────────────
    it("[6] directory lastModified is deterministic across repeated calls", async () => {
      const a = await backend.listObjects(root, { maxKeys: 100 });
      const b = await backend.listObjects(root, { maxKeys: 100 });
      const pick = (r: typeof a) => r.entries.find((e) => e.key === `${root}work/`)!.lastModified;
      expect(pick(a).getTime()).toBe(pick(b).getTime());
    });

    // ── Clause 7 ───────────────────────────────────────────────────────────
    it("[7] an unmatched prefix returns an empty result instead of throwing", async () => {
      const missingDir = await backend.listObjects(`${root}no-such-dir/`);
      expect(missingDir.entries).toEqual([]);
      expect(missingDir.total).toBe(0);

      const missingFragment = await backend.listObjects(`${root}qq`);
      expect(missingFragment.entries).toEqual([]);
      expect(missingFragment.total).toBe(0);
    });

    // ── Clause 8 ───────────────────────────────────────────────────────────
    it("[8] never leaks backend-internal bookkeeping files", async () => {
      const res = await backend.listObjects(root, { recursive: true, maxKeys: 100 });
      expect(res.entries.some((e) => e.key.endsWith(".meta.json"))).toBe(false);
      expect(sortKeys(res.entries)).toEqual(ALL_FILES);
    });

    // ── Clause 9 ───────────────────────────────────────────────────────────
    it("[9] nextMarker is an opaque cursor that pages the full set exactly once", async () => {
      const seen: string[] = [];
      let marker: string | undefined;
      let guard = 0;

      do {
        const page = await backend.listObjects(root, { recursive: true, maxKeys: 2, marker });
        seen.push(...page.entries.map((e) => e.key));
        marker = page.nextMarker;
        if (++guard > 20) throw new Error("pagination did not terminate");
      } while (marker !== undefined);

      expect(seen.slice().sort()).toEqual(ALL_FILES);
      expect(new Set(seen).size).toBe(seen.length);
    });

    // ── Append behaviour (rowfs must reject; see D9.2 consumers) ────────────
    it(supportsAppend
      ? "appends to an existing object"
      : "rejects appendObject with a diagnosable error", async () => {
      if (supportsAppend) {
        await backend.appendObject(K.beta, "\nmore");
        const obj = await backend.getObject(K.beta);
        expect(obj!.content.toString()).toBe("# beta\nmore");
      } else {
        await expect(backend.appendObject(K.beta, "\nmore")).rejects.toThrow();
      }
    });

    // ── Baseline read/write invariants the clauses above rely on ────────────
    it("round-trips putObject/getObject and reports absence as null", async () => {
      const obj = await backend.getObject(K.alpha);
      expect(obj!.content.toString()).toBe("# alpha");
      expect(await backend.getObject(`${root}absent.md`)).toBeNull();
      expect(await backend.exists(K.alpha)).toBe(true);
      expect(await backend.exists(`${root}absent.md`)).toBe(false);
    });

    it("deleteObject is idempotent and hides the key from listings", async () => {
      await backend.deleteObject(K.zeta);
      await backend.deleteObject(K.zeta);
      expect(await backend.exists(K.zeta)).toBe(false);
      const res = await backend.listObjects(root, { recursive: true, maxKeys: 100 });
      expect(res.entries.some((e) => e.key === K.zeta)).toBe(false);
    });
  });
}
