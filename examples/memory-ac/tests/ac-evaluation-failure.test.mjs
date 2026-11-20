import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluatePhase} from '../src/ac-evaluation-v1-1.mjs';
import {hash} from '../src/adapters.mjs';
test('a truncated Reader answer remains in the denominator with no fictitious Judge call', async () => {
  const v = {probe_id: 'q', mode: 'a', group_id: 'g', split: 'calibration', query: 'q', context: 'c', context_sha256: hash('c')}; let calls = 0;
  const rows = [];
  for await (const r of evaluatePhase({views: [v], references: new Map([['q', {answer: 'x'}]]),
    answers: new Map([['q|a', {key: 'reader', text: 'unfinished', inference_failed: true}]]), phase: 'judge',
    adapter: {readerMessages() {}, judgeMessages() {throw Error('must_not_judge_partial');}, parseVerdict() {}},
    infer: async () => {calls++;}})) rows.push(r);
  assert.equal(rows.length, 1); assert.equal(rows[0].correct, 0); assert.equal(rows[0].key, null); assert.equal(rows[0].actual_api_call, false); assert.equal(calls, 0);
});
