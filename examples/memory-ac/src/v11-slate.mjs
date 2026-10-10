import {hash} from './adapters.mjs';
import {candidateFeatures, residualScores} from './v10-residual.mjs';
import {selectFixed} from './v9-selection.mjs';

export const SLATE = Object.freeze({version: 'ac-slate-feedback-v11.0', dimensions: 32,
  maxPairs: 4096, maxCandidates: 3, epochs: 400, step: .2, ridge: .01, maxNorm: 4,
  folds: 5, interventionWeight: .2, costWeight: .03, stabilityMargin: .01});
export const ACTIONS = Object.freeze(['qwen_fixed', 'qa_residual', 'intervention_residual']);
const dot = (a, b) => a.reduce((n, v, i) => n + v * b[i], 0);
const vector = x => Array.isArray(x) && x.length === SLATE.dimensions && x.every(Number.isFinite);
const words = s => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const jac = (a, b) => {const n = [...a].filter(x => b.has(x)).length; return n / Math.max(1, a.size + b.size - n);};

// Full ordered-context features in BOTH fitting and inference. No labels or dataset fields.
export function slateFeatures({query, items, scores, mapping, nativeIds, selected, tokens, budget}) {
  if (selected.length > 5 || new Set(selected.map(x => x.id)).size !== selected.length
    || !Number.isInteger(tokens) || tokens < 0 || !Number.isInteger(budget) || budget < tokens) throw Error('slate_bounds');
  const fs = candidateFeatures({query, items, scores, mapping, nativeIds});
  if (selected.some(x => !fs.has(x.id) || mapping.accepted[x.id].content_hash !== hash(x.content))) throw Error('slate_foreign_item');
  const chosen = new Set(selected.map(x => x.id)), vs = selected.map(x => fs.get(x.id)), n = selected.length;
  const groups = [...new Set(selected.map(x => mapping.accepted[x.id].turn_id))];
  const q = words(query), vocab = selected.map(x => words(x.content)), union = new Set(vocab.flatMap(x => [...x]));
  const dates = selected.map(x => Date.parse(mapping.accepted[x.id].source_date)).filter(Number.isFinite);
  const redundancy = []; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) redundancy.push(jac(vocab[i], vocab[j]));
  const x = [...Array.from({length: 16}, (_, i) => mean(vs.map(v => v.x[i]))),
    n / 5, tokens / Math.max(1, budget), mean(vs.map(v => v.base)),
    n ? Math.min(...vs.map(v => v.base)) : 0, n ? Math.max(...vs.map(v => v.base)) : 0,
    vs.reduce((s, v, i) => s + v.base / (i + 1), 0) / 2.283333333333333,
    new Set(selected.map(v => mapping.accepted[v.id].session_id)).size / 5,
    mean(groups.map(t => Number(mapping.turns[t].every(id => chosen.has(id))))),
    [...q].filter(w => union.has(w)).length / Math.max(1, q.size), mean(redundancy),
    Math.min(1, dates.length ? (Math.max(...dates) - Math.min(...dates)) / (365 * 86400000) : 0),
    vs[0]?.x[3] ?? 0, vs.at(-1)?.x[3] ?? 0, vs[0]?.base ?? 0, vs.at(-1)?.base ?? 0,
    Number(/\b(all|both|compare|between|list|how many|summary|summarize)\b/i.test(query)) * groups.length / 5];
  if (!vector(x)) throw Error('slate_feature');
  return x;
}

export function buildSlates({query, items, scores, mapping, native_items, cost, budget, heads}) {
  const features = candidateFeatures({query, items, scores, mapping, nativeIds: native_items.map(x => x.id)});
  return ACTIONS.map(action => {
    const s = selectFixed({items, scores: action === 'qwen_fixed' ? scores : residualScores(heads[action], features), cost, budget, alpha: 1});
    return {...s, action, x: slateFeatures({query, items, scores, mapping, nativeIds: native_items.map(x => x.id), selected: s.items, tokens: s.tokens, budget})};
  });
}

// Conversation-level weighting and deterministic leave-group-fold-out stability ensemble.
// Ensemble agreement is a heuristic, not a calibrated probability or confidence interval.
export function fitSlate(pairs, variant = 'qa') {
  if (!['qa', 'active', 'uniform', 'sham'].includes(variant) || !pairs.length || pairs.length > SLATE.maxPairs) throw Error('slate_training_bounds');
  if (pairs.some(r => r.split !== 'train' || typeof r.group_id !== 'string' || typeof r.probe_id !== 'string'
    || typeof r.dataset !== 'string' || !vector(r.positive) || !vector(r.negative)
    || !['qa', 'active', 'uniform'].includes(r.source))) throw Error('slate_training_contract');
  const samples = pairs.filter(r => r.source === 'qa' || r.source === (variant === 'sham' ? 'active' : variant));
  const folds = Array.from({length: SLATE.folds}, (_, fold) => {
    const rs = samples.filter(r => parseInt(hash('v11-fold:' + r.group_id).slice(0, 8), 16) % SLATE.folds !== fold);
    if (!rs.some(r => r.source === 'qa')) throw Error('slate_empty_training_fold');
    const families = [...new Set(rs.map(r => r.source))], counts = new Map(), datasets = {}, groups = {};
    for (const r of rs) {const k = r.source + '|' + r.dataset + '|' + r.group_id; counts.set(k, (counts.get(k) ?? 0) + 1);}
    for (const f of families) {
      datasets[f] = [...new Set(rs.filter(r => r.source === f).map(r => r.dataset))];
      for (const d of datasets[f]) groups[f + '|' + d] = new Set(rs.filter(r => r.source === f && r.dataset === d).map(r => r.group_id)).size;
    }
    const weighted = rs.map(r => ({...r,
      sign: variant === 'sham' && r.source === 'active' && parseInt(hash('v11-sham:' + r.probe_id).slice(0, 8), 16) % 2 === 0 ? -1 : 1,
      weight: (families.length === 1 ? 1 : r.source === 'qa' ? 1 - SLATE.interventionWeight : SLATE.interventionWeight)
        / datasets[r.source].length / groups[r.source + '|' + r.dataset] / counts.get(r.source + '|' + r.dataset + '|' + r.group_id)}));
    const w = Array(SLATE.dimensions).fill(0);
    for (let epoch = 0; epoch < SLATE.epochs; epoch++) {
      const gradient = w.map(v => 2 * SLATE.ridge * v);
      for (const r of weighted) {
        const diff = r.positive.map((v, i) => r.sign * (v - r.negative[i]));
        const factor = -r.weight / (1 + Math.exp(Math.max(-30, Math.min(30, dot(w, diff)))));
        for (let i = 0; i < w.length; i++) gradient[i] += factor * diff[i];
      }
      for (let i = 0; i < w.length; i++) w[i] -= SLATE.step * gradient[i];
      const norm = Math.hypot(...w); if (norm > SLATE.maxNorm) for (let i = 0; i < w.length; i++) w[i] *= SLATE.maxNorm / norm;
    }
    return {weights: w, excluded_fold: fold, pairs: rs.length};
  });
  return {version: SLATE.version, variant, hyperparameters: SLATE, folds, pairs: samples.length,
    groups: new Set(samples.map(r => r.group_id)).size, calibrated: false};
}

export function chooseSlate(model, candidates, {stable = true} = {}) {
  if (model?.version !== SLATE.version || JSON.stringify(model.hyperparameters) !== JSON.stringify(SLATE)
    || !Array.isArray(model.folds) || model.folds.length !== SLATE.folds
    || model.folds.some(f => !vector(f.weights) || Math.hypot(...f.weights) > SLATE.maxNorm + 1e-8)
    || JSON.stringify(model).length > 40000) throw Error('slate_model');
  if (!Array.isArray(candidates) || candidates.length !== 3 || candidates.some((c, i) => c.action !== ACTIONS[i] || !vector(c.x))) throw Error('slate_candidates');
  const base = candidates[0];
  const decisions = candidates.map(c => {
    const gains = model.folds.map(f => dot(f.weights, c.x.map((v, i) => v - base.x[i])) - SLATE.costWeight * (c.x[17] - base.x[17]));
    return {action: c.action, gain: stable ? Math.min(...gains) : mean(gains), fold_gains: gains};
  });
  let index = 0;
  for (let i = 1; i < decisions.length; i++) if (decisions[i].gain > SLATE.stabilityMargin && decisions[i].gain > decisions[index].gain) index = i;
  return {...candidates[index], routed_action: candidates[index].action, decision: decisions, stable, calibrated: false};
}
