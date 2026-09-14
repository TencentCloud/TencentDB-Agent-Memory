import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {SLATE, fitSlate, chooseSlate, ACTIONS} from '../src/v11-slate.mjs';
import {acquire, removalOpportunities} from '../src/v11-acquisition.mjs';
import {hash} from '../src/adapters.mjs';
const feature = n => [n, ...Array(31).fill(0)];
const pairs = Array.from({length: 25}, (_, i) => ({split: 'train', group_id: 'g' + i, probe_id: 'q' + i,
  dataset: 'arbitrary_internal_schema', source: 'qa', positive: feature(1), negative: feature(0)}));
test('v11 full-context learner is deterministic and learns preference in held-out fold ensemble', () => {
  const m = fitSlate(pairs); assert.deepEqual(m, fitSlate(pairs));
  assert(m.folds.every(f => f.weights[0] > 0 && Math.hypot(...f.weights) <= SLATE.maxNorm));
  const cs = ACTIONS.map((action, i) => ({action, x: feature(i === 1 ? 1 : 0)}));
  assert.equal(chooseSlate(m, cs).routed_action, 'qa_residual');
});
test('v11 refuses development, unknown labels, invalid dimensions and damaged models', () => {
  assert.throws(() => fitSlate([{...pairs[0], split: 'development'}]), /contract/);
  assert.throws(() => fitSlate([{...pairs[0], source: 'gold'}]), /contract/);
  assert.throws(() => fitSlate([{...pairs[0], positive: [1]}]), /contract/);
  const m = fitSlate(pairs); m.folds[0].weights[0] = NaN;
  assert.throws(() => chooseSlate(m, []), /model/);
});
test('v11 zero weights exactly retain fixed Qwen action under ties', () => {
  const m = fitSlate(pairs); m.folds.forEach(f => f.weights.fill(0));
  assert.equal(chooseSlate(m, ACTIONS.map(action => ({action, x: feature(0)}))).routed_action, 'qwen_fixed');
});
test('v11 active acquisition chooses repair first; uniform is deterministic; no protected selection', () => {
  const xs = Array.from({length: 40}, (_, i) => ({split: 'train', probe_id: 'p' + i, key: 'k' + i, novelty: -i, repair: Number(i === 39)}));
  assert.equal(acquire(xs, 'active')[0].probe_id, 'p39'); assert.equal(acquire(xs, 'active').length, 32);
  assert.deepEqual(acquire(xs, 'uniform'), acquire([...xs].reverse(), 'uniform'));
  assert.throws(() => acquire([{...xs[0], split: 'protected_test'}], 'active'), /contract/);
});
test('v11 removal match controls item count and exact supplied cost', () => {
  const items = ['a', 'b', 'c'].map(id => ({id, content: 'text ' + id}));
  const mapping = {accepted: Object.fromEntries(items.map(x => [x.id, {turn_id: x.id, content_hash: hash(x.content)}])), turns: {a: ['a'], b: ['b'], c: ['c']}};
  const xs = removalOpportunities({probeId: 'q', items, mapping, goldIds: ['a'], cost: xs => 10 + xs.length * 20});
  assert.equal(xs.length, 2); assert(xs.every(x => x.token_gap === 0 && x.support_items.length === x.control_items.length));
  assert.deepEqual(removalOpportunities({probeId: 'q', items: items.slice(1), mapping, goldIds: ['a'], cost: xs => xs.length * 20}), []);
});
test('v11 inference module does not import evaluator/acquisition or access gold/reference fields', async () => {
  const code = await readFile(new URL('../src/v11-slate.mjs', import.meta.url), 'utf8');
  assert(!/v11-acquisition|goldIds|gold_ids|\.ref\b|\.correct\b/.test(code));
});
