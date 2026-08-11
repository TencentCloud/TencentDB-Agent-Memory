/**
 * tz-05 Ф5 — scope and provenance for the L3 carrier (the profile).
 *
 * persona.md itself stays byte-clean: it is hashed into the apply manifest
 * (`apply-executor/validate.ts:142`), diffed by consolidation, and injected
 * verbatim into prompts — a front-matter block there would change all three at
 * once. The attributes therefore live beside the file, in the same
 * engineering-owned `.metadata/` neighbourhood as the scene index, which the
 * LLM sandbox cannot reach either.
 *
 * The profile is global by construction (`profile-sync.ts:26`), so `scope` is
 * written rather than computed — a reader must not have to know that rule.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  PROVENANCE_KEY,
  appendStep,
  readProvenance,
  type Provenance,
  type ProvenanceSource,
} from "../record/provenance.js";

export interface ProfileAttributes {
  scope: string;
  provenance?: Provenance;
}

/** Sidecar path. One file, keyed by profile filename. */
export function profileProvenancePath(dataDir: string): string {
  return path.join(dataDir, ".metadata", "profile_provenance.json");
}

type Sidecar = Record<string, { scope?: unknown; provenance?: unknown }>;

async function readSidecar(dataDir: string): Promise<Sidecar> {
  try {
    const raw = await fs.readFile(profileProvenancePath(dataDir), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Sidecar) : {};
  } catch {
    return {};
  }
}

/** Attributes of one profile file. Undefined when it was never stamped. */
export async function readProfileAttributes(
  dataDir: string,
  filename: string,
): Promise<ProfileAttributes | undefined> {
  const entry = (await readSidecar(dataDir))[filename];
  if (!entry) return undefined;
  const provenance = readProvenance({ [PROVENANCE_KEY]: entry.provenance });
  return {
    scope: typeof entry.scope === "string" ? entry.scope : "",
    ...(provenance ? { provenance } : {}),
  };
}

/**
 * Append one step to a profile's chain. Never throws: it runs off the commit
 * port, after the mutation it describes already happened.
 */
export async function stampProfile(
  dataDir: string,
  filename: string,
  stamp: { role: string; action: string; source: ProvenanceSource },
  now: string = new Date().toISOString(),
): Promise<void> {
  try {
    const sidecar = await readSidecar(dataDir);
    const previous = readProvenance({
      [PROVENANCE_KEY]: sidecar[filename]?.provenance,
    });
    sidecar[filename] = {
      scope: "global",
      provenance: appendStep(
        previous,
        { role: stamp.role, action: stamp.action, at: now },
        stamp.source,
        now,
      ),
    };
    const target = profileProvenancePath(dataDir);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(sidecar, null, 2), "utf-8");
  } catch {
    // The profile stands either way; the miss shows up as a chain that skips
    // a step, which is visible, unlike a thrown error swallowed by the port.
  }
}
