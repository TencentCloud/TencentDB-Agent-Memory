/**
 * IStorageBackend conformance suite — harness wiring for the backends that
 * ship in the open-source tree.
 *
 * `storage-backend.contract.ts` holds the normative D9.2 clauses: every
 * `IStorageBackend` implementation must pass that identical suite so upper
 * layers (scene navigation, `/scenario/ls`, the read tools) behave the same no
 * matter which backend is mounted. The suite exists because Local and COS were
 * found to disagree on four axes while both were already in production
 * (design doc D9.1). Until now the suite had no caller at all — it was
 * documentation, not a test.
 *
 * Two harnesses are wired here, both runnable offline with no credentials:
 *
 *   - `local`      — LocalStorageBackend, the standalone default.
 *   - `rowfs`      — CompositeStorageBackend, the `FILE_STORE_MODE=rowfs`
 *                    mount, with two Local backends standing in for its
 *                    profile / others legs. Its routing (point ops by
 *                    `isProfileKey`, prefix ops by whether the prefix selects
 *                    the profile key space, universal prefix → others leg
 *                    only) is what the suite exercises: the fixture keys are
 *                    all non-profile, so every clause runs against the others
 *                    leg through the router.
 *
 * COS cannot be hosted here — it needs live credentials and a bucket. The
 * `createStorageBackend` factory loads it dynamically, so a COS harness can be
 * added later behind the same suite without touching this file.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorageBackend } from "../local-backend.js";
import { CompositeStorageBackend } from "../composite-backend.js";
import { runStorageBackendContract } from "./storage-backend.contract.js";

/** Create a throwaway directory and return it plus a disposer. */
function tmpDir(label: string): { dir: string; dispose: () => Promise<void> } {
  const dir = mkdtempSync(join(tmpdir(), `storage-contract-${label}-`));
  return {
    dir,
    dispose: async () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ── local ────────────────────────────────────────────────────────────────────

{
  const { dir, dispose } = tmpDir("local");
  runStorageBackendContract("local", async () => ({
    backend: new LocalStorageBackend(dir),
    cleanup: dispose,
  }));
}

// ── rowfs (CompositeStorageBackend over two local legs) ──────────────────────

{
  const profile = tmpDir("rowfs-profile");
  const others = tmpDir("rowfs-others");
  runStorageBackendContract("rowfs", async () => ({
    backend: new CompositeStorageBackend({
      profileBackend: new LocalStorageBackend(profile.dir),
      others: new LocalStorageBackend(others.dir),
    }),
    cleanup: async () => {
      await profile.dispose();
      await others.dispose();
    },
  }));
}
