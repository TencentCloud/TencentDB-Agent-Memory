import assert from 'node:assert/strict';
import test from 'node:test';
import { fit } from './fit.js';
const hits=Array.from({length:12},(_,i)=>({id:`m${i}`,content:'a memory',score:1-i/100}));
test('test feedback and answer text cannot affect fitted policy',()=>{
 const rows=['train','dev','test'].map(split=>({query_id:split,split,baseline:hits.slice(0,5),expanded:hits}));
 const labels=Object.fromEntries(['train','dev','test'].map(split=>[split,{split,evidence_ids:['m6']} ]));
 const before=fit(rows,labels);
 const changed=fit(rows,{...labels,test:{split:'test',evidence_ids:['m0']}});
 assert.deepEqual(before,changed);assert.equal(before.test_labels_used_for_fit,0);
});
test('development cost gate rejects an expensive recall gain',()=>{
 const rows=['train','dev'].map(split=>({query_id:split,split,baseline:hits.slice(0,5),expanded:hits}));
 const labels=Object.fromEntries(['train','dev'].map(split=>[split,{split,evidence_ids:['m6']} ]));
 const fitted=fit(rows,labels);
 assert.equal(fitted.dev.gates.recall_gain_5pp,true);
 assert.equal(fitted.dev.gates.injection_bytes_at_most_2x,false);
 assert.equal(fitted.policy.approved,false);
});
test('empty training and missing labels are errors, never fabricated feedback',()=>{
 assert.throws(()=>fit([],{}));
 assert.throws(()=>fit([{query_id:'t',split:'train',baseline:[],expanded:[]}],{}));
});
