import Graph from "graphology";
import { describe, expect, it } from "vitest";
import { graphMultiHopSearch, type GraphSearchSeed } from "./graph-search.js";

function makeGraph(nodes: string[], edges: Array<[string, string]>): Graph {
  const graph = new Graph({ type: "undirected" });
  for (const id of nodes) graph.addNode(id, { label: `Page ${id}` });
  for (const [a, b] of edges) graph.addEdge(a, b);
  return graph;
}

const options = { hop: 3, decay: 0.8, minScore: 0, maxNodes: 200 };

describe("graphMultiHopSearch", () => {
  it.each([false, true])("propagates the strongest same-layer arrival (reverse=%s)", (reverse) => {
    const graph = makeGraph(["low", "high", "middle", "tail"], [
      ["low", "middle"], ["high", "middle"], ["middle", "tail"],
    ]);
    const seeds = [{ id: "low", score: 2 }, { id: "high", score: 10 }];
    if (reverse) seeds.reverse();
    const hits = graphMultiHopSearch(graph, seeds, { ...options, hop: 2 });
    expect(hits.find((hit) => hit.id === "middle")).toMatchObject({ score: 8, hop: 1, via: "Page high" });
    expect(hits.find((hit) => hit.id === "tail")?.score).toBeCloseTo(6.4);
  });

  it.each([false, true])("re-expands a better longer path without exceeding the hop budget (reverse=%s)", (reverse) => {
    const graph = makeGraph(["high", "low", "a", "middle", "tail"], [
      ["high", "a"], ["a", "middle"], ["low", "middle"], ["middle", "tail"],
    ]);
    const seeds = [{ id: "high", score: 10 }, { id: "low", score: 2 }];
    if (reverse) seeds.reverse();
    const twoHops = graphMultiHopSearch(graph, seeds, { ...options, hop: 2 });
    const threeHops = graphMultiHopSearch(graph, seeds, options);
    expect(twoHops.find((hit) => hit.id === "tail")?.score).toBeCloseTo(1.28);
    expect(threeHops.find((hit) => hit.id === "tail")).toMatchObject({ hop: 2, via: "Page middle" });
    expect(threeHops.find((hit) => hit.id === "tail")?.score).toBeCloseTo(5.12);
    expect(threeHops.find((hit) => hit.id === "middle")).toMatchObject({ hop: 1, via: "Page a" });
  });

  it("freezes seed scores, deduplicates seeds and ignores missing nodes", () => {
    const graph = makeGraph(["a", "b", "c"], [["a", "b"], ["b", "c"]]);
    const hits = graphMultiHopSearch(graph, [
      { id: "a", score: 10 }, { id: "b", score: 1 }, { id: "a", score: 5 }, { id: "missing", score: 100 },
    ], options);
    expect(hits.find((hit) => hit.id === "a")).toEqual({ id: "a", score: 10, hop: 0 });
    expect(hits.find((hit) => hit.id === "b")).toEqual({ id: "b", score: 1, hop: 0 });
    expect(hits.find((hit) => hit.id === "c")?.score).toBeCloseTo(0.8);
    expect(hits).toHaveLength(3);
  });

  it("returns only seeds at hop zero and no hits without valid seeds", () => {
    const graph = makeGraph(["a", "b"], [["a", "b"]]);
    expect(graphMultiHopSearch(graph, [{ id: "a", score: 2 }], { ...options, hop: 0 }))
      .toEqual([{ id: "a", score: 2, hop: 0 }]);
    expect(graphMultiHopSearch(graph, [], options)).toEqual([]);
    expect(graphMultiHopSearch(graph, [{ id: "missing", score: 2 }], options)).toEqual([]);
  });

  it("applies the score threshold to expansion and seeds", () => {
    const graph = makeGraph(["a", "b", "c", "isolated"], [["a", "b"], ["b", "c"]]);
    const hits = graphMultiHopSearch(graph, [{ id: "a", score: 10 }, { id: "isolated", score: 1 }],
      { ...options, minScore: 7 });
    expect(hits.map((hit) => hit.id)).toEqual(["a", "b"]);
  });

  it.each([0, 1])("handles cycles, self-loops and disconnected nodes at decay=%s", (decay) => {
    const graph = makeGraph(["a", "b", "c", "isolated"], [["a", "b"], ["b", "c"], ["c", "a"], ["b", "b"]]);
    const hits = graphMultiHopSearch(graph, [{ id: "a", score: 10 }], { ...options, decay, hop: 5 });
    expect(hits).toHaveLength(3);
    expect(hits.find((hit) => hit.id === "b")).toMatchObject({ hop: 1, score: 10 * decay });
    expect(hits.find((hit) => hit.id === "c")).toMatchObject({ hop: 1, score: 10 * decay });
  });

  it("preserves the visited-node cap and does not expand when seeds fill it", () => {
    const graph = makeGraph(["a", "b", "c", "d"], [["a", "b"], ["a", "c"], ["c", "d"]]);
    expect(graphMultiHopSearch(graph, [{ id: "a", score: 10 }], { ...options, maxNodes: 2 })).toHaveLength(2);
    expect(graphMultiHopSearch(graph, [{ id: "a", score: 10 }], { ...options, maxNodes: 1 }))
      .toEqual([{ id: "a", score: 10, hop: 0 }]);
  });

  it("falls back to node IDs for path labels", () => {
    const graph = makeGraph(["a", "b"], [["a", "b"]]);
    graph.removeNodeAttribute("a", "label");
    expect(graphMultiHopSearch(graph, [{ id: "a", score: 10 }], options)[1].via).toBe("a");
  });

  it("matches exhaustive bounded-walk scores and minimum hops on all four-node simple graphs", () => {
    const nodes = ["a", "b", "c", "d"];
    const edges: Array<[string, string]> = [["a", "b"], ["a", "c"], ["a", "d"], ["b", "c"], ["b", "d"], ["c", "d"]];
    for (let mask = 0; mask < 64; mask++) {
      const graph = makeGraph(nodes, edges.filter((_, i) => mask & (1 << i)));
      for (const decay of [0, 0.5, 1]) {
        for (const hop of [0, 1, 2, 3, 4]) {
          for (const seeds of [[{ id: "a", score: 10 }, { id: "b", score: 2 }], [{ id: "b", score: 2 }, { id: "a", score: 10 }]]) {
            const expected = enumerateWalks(graph, seeds, hop, decay);
            const hits = graphMultiHopSearch(graph, seeds, { ...options, hop, decay });
            expect(hits).toHaveLength(expected.size);
            for (const hit of hits) {
              expect(hit.score).toBeCloseTo(expected.get(hit.id)!.score);
              expect(hit.hop).toBe(expected.get(hit.id)!.hop);
            }
          }
        }
      }
    }
  });
});

// Independent oracle: enumerate every walk within the hop budget, without
// score-based pruning or a frontier; seed nodes remain frozen as in the API.
function enumerateWalks(graph: Graph, seeds: GraphSearchSeed[], maxHop: number, decay: number) {
  const seedIds = new Set(seeds.map((seed) => seed.id));
  const result = new Map(seeds.map((seed) => [seed.id, { score: seed.score, hop: 0 }]));
  function visit(id: string, score: number, hop: number) {
    if (hop === maxHop) return;
    for (const next of graph.neighbors(id)) {
      if (seedIds.has(next)) continue;
      const nextScore = score * decay;
      const previous = result.get(next);
      result.set(next, { score: Math.max(previous?.score ?? -Infinity, nextScore), hop: Math.min(previous?.hop ?? Infinity, hop + 1) });
      visit(next, nextScore, hop + 1);
    }
  }
  for (const seed of seeds) visit(seed.id, seed.score, 0);
  return result;
}
