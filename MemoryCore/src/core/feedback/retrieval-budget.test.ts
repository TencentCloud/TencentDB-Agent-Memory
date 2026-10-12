import assert from 'node:assert/strict';
import test from 'node:test';
import { retrieveWithBudget, selectBudget, BUDGET_THRESHOLDS } from './retrieval-budget.js';
const hits = Array.from({length: 12}, (_, i) => ({id: `m${i}`, content: `source ${i}`, score: 1-i/20}));
const base = hits.slice(0, 5);
const policy = { schemaVersion: 1 as const, threshold: 0.05, approved: true };

test('off delegates once without inspecting optional policy or callback', async () => {
  let n = 0;
  const r = await retrieveWithBudget({baseline: () => {n++; return base;},
    expanded: () => {throw new Error('must not run');}, policy: {get bad() {throw Error();}}});
  assert.strictEqual(r.hits, base); assert.equal(n,1); assert.equal(r.auxiliaryCalls,0);
  assert.equal(r.fallback,false);
});
test('expanded policy preserves source prefix, has no new text or writes', async () => {
  const frozen = hits.map(x => Object.freeze({...x})); Object.freeze(frozen);
  const r = await retrieveWithBudget({baseline: () => frozen.slice(0,5), expanded: () => frozen,
    mode: 'candidate', policy: {...policy, threshold: 1}});
  assert.strictEqual(r.hits,frozen); assert.equal(r.k,12); assert.equal(r.auxiliaryCalls,1);
});
test('small boundary threshold retains exact baseline', () => {
  assert.strictEqual(selectBudget(base,hits,{...policy,threshold:0}).hits,base);
});
test('unapproved deployment returns baseline without auxiliary work', async () => {
  const r = await retrieveWithBudget({baseline: () => base, expanded: () => {throw Error();},
    mode: 'adaptive', policy: {...policy,approved:false}});
  assert.strictEqual(r.hits,base); assert.equal(r.reason,'not_adopted'); assert.equal(r.auxiliaryCalls,0);
});
test('forced exception returns original base and fixed safe error code', async () => {
  const r = await retrieveWithBudget({baseline: () => base, expanded: () => {throw Error('private text');},
    mode:'candidate', policy});
  assert.strictEqual(r.hits,base); assert.equal(r.reason,'auxiliary_error');
  assert.ok(!JSON.stringify({...r,hits:[]}).includes('private text'));
});
test('bad policy and invalid hit shapes cannot change baseline', async () => {
  for (const p of [null, {...policy,threshold:NaN}, {...policy,threshold:0.2}, {...policy,extra:true}]) {
    const r = await retrieveWithBudget({baseline:()=>base,expanded:()=>hits,mode:'candidate',policy:p});
    assert.equal(r.reason,'invalid_policy'); assert.strictEqual(r.hits,base);
  }
  for (const invalid of [hits.concat(hits[0]!),hits.map((x,i)=>i===0?{...x,content:'x'.repeat(8193)}:x),
    hits.map((x,i)=>i===6?{...x,id:hits[0]!.id}:x),hits.map(x=>({...x,score:NaN}))]) {
    const r = await retrieveWithBudget({baseline:()=>base,expanded:()=>invalid,mode:'candidate',policy});
    assert.equal(r.fallback,true); assert.strictEqual(r.hits,base);
  }
});
test('different source prefix or order rejects optional result', () => {
  assert.throws(()=>selectBudget(base,[...hits].reverse(),policy));
  assert.throws(()=>selectBudget(base,hits.map((x,i)=>i===0?{...x,content:'changed'}:x),policy));
});
test('empty and short retrieval have explicit stable behavior', async () => {
  const empty: typeof base=[];
  const r=await retrieveWithBudget({baseline:()=>empty,expanded:()=>[],mode:'candidate',policy});
  assert.strictEqual(r.hits,empty); assert.equal(r.gap,null);
  assert.equal(selectBudget(base.slice(0,3),hits.slice(0,3),policy).gap,null);
});
test('baseline exceptions propagate instead of pretending successful fallback', async () => {
  await assert.rejects(retrieveWithBudget({baseline:()=>{throw Error('base_failure');},expanded:()=>hits}));
});
test('all finite policy alternatives obey the same prefix and count bounds', () => {
  for (const threshold of BUDGET_THRESHOLDS) {
    const out=selectBudget(base,hits,{...policy,threshold});
    assert.ok([5,12].includes(out.hits.length));
    assert.deepEqual(out.hits.slice(0,5),base);
  }
});
test('timeout ignores late result and never starts an unbounded number of pending calls', async () => {
  const release: Array<() => void> = [];
  const operations = Array.from({length:4},()=>retrieveWithBudget({baseline:()=>base,
    expanded:()=>new Promise<typeof hits>(resolve=>release.push(()=>resolve(hits))),mode:'candidate',policy}));
  const rows=await Promise.all(operations);
  assert.ok(rows.every(r=>r.reason==='auxiliary_timeout' && r.hits===base));
  const busy=await retrieveWithBudget({baseline:()=>base,expanded:()=>hits,mode:'candidate',policy});
  assert.equal(busy.reason,'auxiliary_busy'); assert.equal(busy.auxiliaryCalls,0);
  release.forEach(fn=>fn()); await new Promise(resolve=>setTimeout(resolve,0));
  const recovered=await retrieveWithBudget({baseline:()=>base,expanded:()=>hits,mode:'candidate',policy});
  assert.equal(recovered.fallback,false);
});
