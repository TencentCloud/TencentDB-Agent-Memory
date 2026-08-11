/**
 * tz-05 Ф5 — provenance takes the commit port's one observer slot by composing
 * with the counter observer, exactly as tz-03b said it would
 * (`commit-port.ts:6`): one subscriber, not a bus.
 *
 * Order matters. Stamping rewrites the block files, so the counters — which
 * recompute from disk — must run after it, or the recomputation would race the
 * rewrite it was triggered by. The index is resynced last: it carries digests,
 * and a digest taken before the stamp would disagree with the bytes.
 */
import { projectSlug } from "../scene/scene-paths.js";
import {
  syncSceneIndexAllProjects,
  syncSceneIndex,
  writeCarrierAttributes,
} from "../scene/scene-index.js";
import {
  stampAllSceneSlugs,
  stampSceneSlug,
} from "../scene/scene-provenance.js";
import { stampProfile } from "../profile/profile-provenance.js";
import type { MemoryCommitObserver, MemoryMutation } from "./commit-port.js";
import type { ProvenanceSource } from "./provenance.js";

export interface ProvenanceObserverLogger {
  debug?: (msg: string) => void;
  warn?: (msg: string) => void;
}

/**
 * How a mutation source maps onto the closed set of A3 sources. An unknown
 * source is a role doing its job — the two exceptions are the paths that
 * demonstrably are not: a pull imports somebody else's tree, and the cleaner
 * and feedback routes act on a human's instruction.
 */
function sourceOf(mutationSource: string): ProvenanceSource {
  if (mutationSource === "profile-sync") return "import";
  if (mutationSource === "cleaner" || mutationSource === "feedback")
    return "manual";
  return "role-run";
}

/** Wrap an observer so every carrier mutation also stamps its provenance. */
export function withProvenance(
  inner: MemoryCommitObserver,
  dataDir: string,
  logger?: ProvenanceObserverLogger,
): MemoryCommitObserver {
  return {
    async onCommitted(m: MemoryMutation): Promise<void> {
      try {
        await stamp(m, dataDir, logger);
      } catch (err) {
        // The port already guarantees a mutation is never undone by its
        // observer; swallowing here keeps the counters running even so.
        logger?.warn?.(
          `[provenance] stamping failed for ${m.carrier}/${m.kind} from ${m.source}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await inner.onCommitted(m);
    },
  };
}

async function stamp(
  m: MemoryMutation,
  dataDir: string,
  logger?: ProvenanceObserverLogger,
): Promise<void> {
  if (m.carrier === "profile") {
    await stampProfile(dataDir, "persona.md", {
      role: m.source,
      action: m.kind,
      source: sourceOf(m.source),
    });
    logger?.debug?.(`[provenance] profile stamped by ${m.source}/${m.kind}`);
    return;
  }
  if (m.carrier !== "scene") return; // L1 stamps itself inside the writer.

  const stampSpec = {
    role: m.source,
    action: m.kind,
    source: sourceOf(m.source),
    ...(m.projectId ? { projectId: m.projectId } : {}),
  };
  // Order is load-bearing: the stamp rewrites the blocks, the sync recomputes
  // digests from the rewritten bytes AND carries the old carrier fields
  // forward, and only then are the new fields written into the index — which
  // is the L2 truth (scene-index.ts). Writing them before the sync would let
  // the sync carry the OLD values back over the fresh stamp.
  if (m.projectId) {
    const slug = projectSlug(m.projectId);
    const stamped = await stampSceneSlug(dataDir, slug, stampSpec);
    await syncSceneIndex(dataDir, m.projectId);
    await writeCarrierAttributes(dataDir, slug, stamped);
    logger?.debug?.(
      `[provenance] ${stamped.size} scene block(s) stamped for ${m.projectId}`,
    );
    return;
  }
  const bySlug = await stampAllSceneSlugs(dataDir, stampSpec);
  await syncSceneIndexAllProjects(dataDir);
  let total = 0;
  for (const [slug, stamped] of bySlug) {
    await writeCarrierAttributes(dataDir, slug, stamped);
    total += stamped.size;
  }
  logger?.debug?.(
    `[provenance] ${total} scene block(s) stamped across all projects`,
  );
}
