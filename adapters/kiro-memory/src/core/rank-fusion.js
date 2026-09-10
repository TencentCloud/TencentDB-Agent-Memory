const sourceOrder = new Map(['atomic', 'conversation', 'skill'].map((source, index) => [source, index]));
export const compareFusedHits = (left, right) => right.fusedScore - left.fusedScore
  || left.sourceRank - right.sourceRank
  || (sourceOrder.get(left.source) ?? 99) - (sourceOrder.get(right.source) ?? 99)
  || left.stableId.localeCompare(right.stableId);

export function fuseRankedHits(sourceHits, { k = 60 } = {}) {
  const fused = new Map();
  for (const source of ['atomic', 'conversation', 'skill']) {
    const items = sourceHits[source] ?? [];
    const seenStableIds = new Set();
    items.forEach((item, index) => {
      if (seenStableIds.has(item.stableId)) return;
      seenStableIds.add(item.stableId);
      const rank = index + 1;
      const existing = fused.get(item.stableId);
      if (existing) {
        existing.fusedScore += 1 / (k + rank);
        existing.metadata.sources = [...new Set([...existing.metadata.sources, source])];
        if (rank < existing.sourceRank
          || (rank === existing.sourceRank && sourceOrder.get(source) < sourceOrder.get(existing.source))) {
          existing.sourceRank = rank;
          existing.source = source;
        }
      } else {
        fused.set(item.stableId, {
          ...item,
          source,
          sourceRank: rank,
          fusedScore: 1 / (k + rank),
          metadata: { ...(item.metadata ?? {}), sources: [source] },
        });
      }
    });
  }
  return [...fused.values()].sort(compareFusedHits);
}
