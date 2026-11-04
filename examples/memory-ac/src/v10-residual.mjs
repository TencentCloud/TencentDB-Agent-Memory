import {hash} from './adapters.mjs';

export const RESIDUAL = Object.freeze({version: 'ac-controlled-residual-v10.0', dimensions: 16,
  amplitude: .25, epochs: 300, step: .2, ridge: .01, maxNorm: 1, maxPairs: 4096});
const words = s => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
const dot = (a, b) => a.reduce((n, x, i) => n + x * b[i], 0);
const overlap = (a, b) => [...a].filter(x => b.has(x)).length / Math.max(1, a.size);
const finiteVector = x => Array.isArray(x) && x.length === 16 && x.every(Number.isFinite);

// Public candidate features only. References, feedback, category and original IDs are not inputs.
export function candidateFeatures({query, items, scores, mapping, nativeIds = []}) {
  if (typeof query !== 'string' || query.length > 20000 || !Array.isArray(items) || items.length > 64
    || new Set(items.map(x => x.id)).size !== items.length || scores.length !== items.length) throw Error('residual_input');
  const score = new Map(scores.map(x => [x.id, x.score])), native = new Set(nativeIds), pool = new Set(items.map(x => x.id));
  if (score.size !== items.length || items.some(x => !Number.isFinite(score.get(x.id)))) throw Error('residual_scores');
  const ranked = [...items].sort((a, b) => score.get(b.id) - score.get(a.id));
  const rank = new Map(ranked.map((x, i) => [x.id, i])), q = words(query), numbers = new Set(query.match(/\d+/g) ?? []);
  const dates = items.map(x => Date.parse(mapping.accepted[x.id]?.source_date)).filter(Number.isFinite);
  const lo = dates.length ? Math.min(...dates) : 0, hi = dates.length ? Math.max(...dates) : 0;
  const initial = /\b(initial|initially|original|originally|first|earliest)\b/i.test(query);
  const latest = /\b(latest|current|currently|now|last|updated|changed)\b/i.test(query);
  const multiple = /\b(all|both|compare|between|list|how many|summary|summarize)\b/i.test(query);
  return new Map(items.map(x => {
    const m = mapping.accepted[x.id];
    if (!m || m.content_hash !== hash(x.content) || !mapping.turns[m.turn_id]?.includes(x.id)) throw Error('residual_provenance');
    const terms = words(x.content), date = Date.parse(m.source_date);
    const recency = Number.isFinite(date) && hi > lo ? (date - lo) / (hi - lo) : .5;
    const fullTurn = mapping.turns[m.turn_id].every(id => pool.has(id));
    const base = Math.tanh(score.get(x.id) / 10);
    const f = [base, 1 - rank.get(x.id) / Math.max(1, items.length - 1), Number(native.has(x.id)),
      Number(x.role === 'user'), Number(x.role === 'assistant'), overlap(q, terms), recency,
      initial ? 1 - recency : latest ? recency : 0, Math.min(x.content.length, 2000) / 2000,
      Math.tanh(Number.isFinite(x.score) ? x.score / 10 : 0), Number(fullTurn),
      overlap(numbers, new Set(x.content.match(/\d+/g) ?? [])),
      Number(/\b(now|instead|changed|update|replaced|no longer)\b/i.test(x.content)),
      Number(multiple) * Number(fullTurn), Math.min(mapping.turns[m.turn_id].length, 5) / 5,
      overlap(q, terms) * Number(x.role === 'user')];
    if (!finiteVector(f)) throw Error('residual_feature');
    return [x.id, {x: f, base}];
  }));
}

export function meanRepresentation(ids, features) {
  if (!ids.length || ids.length > 5 || new Set(ids).size !== ids.length) throw Error('residual_set');
  const vs = ids.map(id => features.get(id));
  if (vs.some(v => !v)) throw Error('residual_foreign_id');
  return {x: Array.from({length: 16}, (_, i) => vs.reduce((n, v) => n + v.x[i], 0) / vs.length),
    base: vs.reduce((n, v) => n + v.base, 0) / vs.length};
}

export function fitResidual(rows, variant = 'qa') {
  if (!['qa', 'intervention', 'sham'].includes(variant) || !rows.length || rows.length > RESIDUAL.maxPairs) throw Error('residual_training_bounds');
  for (const r of rows) if (!finiteVector(r.positive.x) || !finiteVector(r.negative.x)
    || !Number.isFinite(r.positive.base) || !Number.isFinite(r.negative.base)
    || !['qa', 'intervention'].includes(r.source) || typeof r.probe_id !== 'string') throw Error('residual_pair');
  const active = rows.filter(r => r.source === 'qa' || variant !== 'qa');
  const counts = new Map();
  for (const r of active) {const k = r.source + '|' + r.probe_id; counts.set(k, (counts.get(k) ?? 0) + 1);}
  const families = [...new Set(active.map(r => r.source))];
  const groups = Object.fromEntries(families.map(f => [f, new Set(active.filter(r => r.source === f).map(r => r.probe_id)).size]));
  const samples = active.map(r => {
    const reverse = variant === 'sham' && r.source === 'intervention'
      && parseInt(hash('v10-sham:' + r.probe_id).slice(0, 8), 16) % 2 === 0;
    return {...r, positive: reverse ? r.negative : r.positive, negative: reverse ? r.positive : r.negative,
      weight: 1 / families.length / groups[r.source] / counts.get(r.source + '|' + r.probe_id), reverse};
  });
  const w = Array(16).fill(0);
  for (let epoch = 0; epoch < RESIDUAL.epochs; epoch++) {
    const gradient = w.map(x => 2 * RESIDUAL.ridge * x);
    for (const r of samples) {
      const p = Math.tanh(dot(w, r.positive.x)), n = Math.tanh(dot(w, r.negative.x));
      const z = r.positive.base - r.negative.base + RESIDUAL.amplitude * (p - n);
      const factor = -r.weight / (1 + Math.exp(Math.max(-30, Math.min(30, z))));
      for (let i = 0; i < 16; i++) gradient[i] += factor * RESIDUAL.amplitude
        * ((1 - p * p) * r.positive.x[i] - (1 - n * n) * r.negative.x[i]);
    }
    for (let i = 0; i < 16; i++) w[i] -= RESIDUAL.step * gradient[i];
    const norm = Math.hypot(...w);
    if (norm > RESIDUAL.maxNorm) for (let i = 0; i < 16; i++) w[i] /= norm;
  }
  return {version: RESIDUAL.version, variant, weights: w, hyperparameters: RESIDUAL,
    training_pairs: samples.length, training_groups: groups,
    sham_reversed_pairs: samples.filter(x => x.reverse).length, calibrated_probability: false};
}

export function residualScores(model, features) {
  if (model?.version !== RESIDUAL.version || !finiteVector(model.weights)
    || Math.hypot(...model.weights) > 1.00000001 || JSON.stringify(model).length > 16000
    || JSON.stringify(model.hyperparameters) !== JSON.stringify(RESIDUAL)) throw Error('residual_model');
  return [...features].map(([id, v]) => ({id, score: v.base + RESIDUAL.amplitude * Math.tanh(dot(model.weights, v.x))}));
}
