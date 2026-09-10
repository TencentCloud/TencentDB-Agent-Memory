import { sha256 } from '../core/hash.js';
import { truncateWithMarker, unicodeLength } from '../core/text-budget.js';

const opening = '<TDAI_MEMORY_RESULTS untrusted="true">\n';
const closing = '\n</TDAI_MEMORY_RESULTS>';

export function toStructuredResult(query, result) {
  return {
    query_fingerprint: `sha256:${sha256(query)}`,
    items: result.hits.map((hit) => ({
      source: hit.source,
      stable_id: hit.stableId,
      rank: hit.sourceRank,
      fused_score: hit.fusedScore,
      content: hit.content,
      ...(hit.timestamp === undefined ? {} : { timestamp: hit.timestamp }),
      metadata: hit.metadata,
    })),
    core_content: result.coreContent,
    degraded_sources: result.degradedSources,
    truncated: result.truncated,
  };
}

export function formatMcpResult(structuredContent, maxChars) {
  const render = (value) => `${opening}${JSON.stringify(value)}${closing}`;
  let candidate = structuredContent;
  let text = render(candidate);
  if (unicodeLength(text) <= maxChars) return { content: [{ type: 'text', text }], structuredContent: candidate };

  candidate = { ...structuredContent, items: [], truncated: true };
  const fitTextField = (original, update) => {
    if (typeof original !== 'string') return null;
    const markerLength = unicodeLength(`<TRUNCATED original_chars=${unicodeLength(original)}>`);
    let low = markerLength;
    let high = unicodeLength(original) - 1;
    let best = null;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const value = truncateWithMarker(original, middle);
      if (unicodeLength(render(update(value))) <= maxChars) { best = value; low = middle + 1; }
      else high = middle - 1;
    }
    return best;
  };
  if (unicodeLength(render(candidate)) > maxChars && typeof candidate.core_content === 'string') {
    const fittedCore = fitTextField(candidate.core_content, (value) => ({ ...candidate, core_content: value }));
    candidate = { ...candidate, core_content: fittedCore };
  }
  for (const item of structuredContent.items ?? []) {
    const full = { ...candidate, items: [...candidate.items, item] };
    if (unicodeLength(render(full)) <= maxChars) { candidate = full; continue; }
    const fitted = fitTextField(item.content, (value) => ({ ...candidate, items: [...candidate.items, { ...item, content: value }] }));
    if (fitted !== null) candidate = { ...candidate, items: [...candidate.items, { ...item, content: fitted }] };
    break;
  }
  text = render(candidate);
  if (unicodeLength(text) > maxChars) {
    candidate = { query_fingerprint: structuredContent.query_fingerprint, items: [], degraded_sources: structuredContent.degraded_sources, truncated: true };
    text = render(candidate);
  }
  if (unicodeLength(text) > maxChars) throw new Error('MCP output budget is too small');
  return { content: [{ type: 'text', text }], structuredContent: candidate };
}
