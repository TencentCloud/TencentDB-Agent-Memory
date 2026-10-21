import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluatePhase} from '../src/ac-evaluation.mjs';
import {hash} from '../src/adapters.mjs';
const v = {probe_id: 'private:task', group_id: 'project', mode: 'candidate', dataset: 'unseen_schema', split: 'calibration',
  query: 'Which interface?', context: 'public code evidence', context_sha256: hash('public code evidence'), gold: 'HIDDEN', category: 'HIDDEN'};
const collect = async generator => {const rows = []; for await (const r of generator) rows.push(r); return rows;};
test('custom evaluation adapter/provider supports an unknown dataset without exposing references to Reader', async () => {
  const adapter = {readerMessages: (task, context) => {assert(!JSON.stringify(task).includes('HIDDEN')); return [{role: 'user', content: task.query + context}];},
    judgeMessages: (ref, answer) => [{role: 'user', content: ref.expected + answer}], parseVerdict: text => Number(text === 'approved')};
  const rs = await collect(evaluatePhase({views: [v], references: new Map(), adapter, infer: async () => ({text: 'interface X', key: 'r'}), phase: 'reader'}));
  const js = await collect(evaluatePhase({views: [v], references: new Map([[v.probe_id, {expected: 'X'}]]), adapter,
    answers: new Map([[v.probe_id + '|' + v.mode, rs[0]]]), infer: async () => ({text: 'approved', key: 'j'}), phase: 'judge'}));
  assert.equal(js[0].correct, 1); assert.equal(js[0].reader_key, 'r');
});
test('dataset-neutral evaluation refuses protected data and tampered contexts before API calls', async () => {
  let calls = 0;
  const options = {views: [{...v, split: 'protected_test'}], adapter: {readerMessages() {}, judgeMessages() {}, parseVerdict() {}},
    infer: async () => {calls++;}, phase: 'reader'};
  await assert.rejects(collect(evaluatePhase(options)), /split/);
  await assert.rejects(collect(evaluatePhase({...options, views: [{...v, context: 'modified'}]})), /context/);
  assert.equal(calls, 0);
});
