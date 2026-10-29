/**
 * Graph multi-hop search — BFS expansion over the wiki graph.
 *
 * Starting from BM25 seed hits, walks `[[wikilink]]` edges up to `hop` levels,
 * decaying score per hop. Seeds keep their original BM25 score and hop=0
 * regardless of incoming decayed paths (PRD AC-1). For non-seed nodes reached
 * via multiple paths, the highest score wins (PRD AC-5); BFS layer order
 * guarantees that first arrival fixes the min-hop value, so later, lower-hop
 * arrivals cannot occur and we only need to compare scores.
 *
 * Sized for thousands of pages — plain layer BFS, hard cap on visited count
 * to bound DoS risk on dense graphs.
 */

import type Graph from "graphology";

export interface GraphSearchSeed {
  id: string;
  score: number;
}

export interface GraphSearchHit {
  id: string;
  score: number;
  hop: number;
  /** Title of the previous-hop node on the best-scoring path. Absent for hop=0. */
  via?: string;
}

export interface GraphSearchOptions {
  hop: number;
  decay: number;
  minScore: number;
  /** Hard cap on total visited nodes (PRD §5.1). */
  maxNodes?: number;
}

const DEFAULT_MAX_NODES = 200;

export function graphMultiHopSearch(
  graph: Graph,
  seeds: GraphSearchSeed[],
  opts: GraphSearchOptions,
): GraphSearchHit[] {
  const { hop: maxHop, decay, minScore } = opts;
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;

  const seedSet = new Set<string>();
  const best = new Map<string, GraphSearchHit>();

  for (const s of seeds) {
    if (!graph.hasNode(s.id)) continue;
    seedSet.add(s.id);
    const prev = best.get(s.id);
    if (!prev || s.score > prev.score) {
      best.set(s.id, { id: s.id, score: s.score, hop: 0 });
    }
  }

  if (maxHop > 0) {
    let frontier = new Map(best);
    let capped = best.size >= maxNodes;
    for (let h = 1; h <= maxHop && frontier.size > 0 && !capped; h++) {
      const nextFrontier = new Map<string, GraphSearchHit>();
      outer: for (const cur of frontier.values()) {
        const viaLabel = (graph.getNodeAttribute(cur.id, "label") as string | undefined) ?? cur.id;
        for (const nb of graph.neighbors(cur.id)) {
          // Seeds are frozen at hop=0 with BM25 score (PRD AC-1).
          if (seedSet.has(nb)) continue;
          const nbScore = cur.score * decay;
          if (nbScore < minScore) continue;
          const existing = best.get(nb);
          if (existing && existing.score >= nbScore) continue;
          const hit: GraphSearchHit = { id: nb, score: nbScore, hop: existing?.hop ?? h, via: viaLabel };
          best.set(nb, hit);
          // Propagate every score improvement, retaining only the strongest
          // arrival per node in this layer. Keep the current frontier unchanged:
          // a better, longer path must spend another hop before propagating,
          // even though the result's hop still records the shortest arrival.
          nextFrontier.set(nb, hit);
          if (best.size >= maxNodes) { capped = true; break outer; }
        }
      }
      frontier = nextFrontier;
    }
  }

  const out: GraphSearchHit[] = [];
  for (const hit of best.values()) {
    if (hit.score >= minScore) out.push(hit);
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
