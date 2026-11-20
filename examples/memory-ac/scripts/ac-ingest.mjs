import {readFile, writeFile, mkdir, appendFile} from 'node:fs/promises';
import {resolve, sep} from 'node:path';
import assert from 'node:assert/strict';
import {adaptRows} from '../src/v10-data.mjs';
import {ExperimentGateway} from '../src/experiment-gateway.mjs';
import {hash} from '../src/adapters.mjs';
import {prepareV9} from '../src/v9-context.mjs';
import {view} from '../src/ten-rounds-data-v1-2.mjs';
const args = Object.fromEntries(Array.from({length: (process.argv.length - 2) / 2}, (_, i) =>
  [process.argv[2 + 2 * i].replace(/^--/, ''), process.argv[3 + 2 * i]]));
for (const field of ['adapter', 'data', 'split', 'out', 'runtime']) assert(args[field], field);
for (const key of Object.keys(args)) assert(['adapter', 'data', 'split', 'out', 'runtime', 'expected-questions', 'frozen-model'].includes(key));
const out = resolve(args.out), runtime = resolve(args.runtime), cwd = resolve('.');
assert(out.startsWith(cwd + sep) && runtime.startsWith(cwd + sep));
await mkdir(out); // Refuse existing output. Never create a second result over the first one.
const sourceFiles = ['scripts/ac-ingest.mjs', 'src/v10-data.mjs', 'src/v9-beam-adapter-v1-1.mjs',
  'src/v9-beam-adapter.mjs', 'src/opaque-provenance.mjs', 'src/experiment-gateway.mjs', args.data,
  ...(args['frozen-model'] ? [args['frozen-model']] : [])];
await writeFile(out + '/ingest-protocol.json', JSON.stringify({at: new Date().toISOString(), adapter: args.adapter, split: args.split,
  data_file: args.data, one_subject_per_shard: true, expected_questions: args['expected-questions'] ? Number(args['expected-questions']) : null,
  frozen_model: args['frozen-model'] ?? null, new_chat_cap_for_external_evaluation: 2000,
  no_fitting: true, protected_access: false, baseline: 'Real MemoryCore L0 FTS native k5 before any reranking',
  source_hashes: Object.fromEntries(await Promise.all(sourceFiles.map(async f => [f, hash(await readFile(f))])))
}, null, 2), {flag: 'wx'});
const raw = (await readFile(args.data, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const adapted = adaptRows(raw, args), n = adapted.reduce((count, x) => count + x.subject.probes.length, 0);
if (args['expected-questions']) assert.equal(n, Number(args['expected-questions']));
await writeFile(out + '/subjects.json', JSON.stringify(adapted.map(x => ({subject_id: x.subject.subject_id,
  group_id: x.subject.group_id, probes: x.subject.probes.length, history_messages: x.subject.messages.length})), null, 2), {flag: 'wx'});
const gateway = new ExperimentGateway(runtime); let written = 0, completed = 0;
try {
  for (const [shard, a] of adapted.entries()) {
    const s = a.subject; await gateway.start(shard); const mapping = await gateway.ingest(s);
    written += Object.keys(mapping.accepted).length;
    for (const p of s.probes) {
      const native = await gateway.client.search(mapping.scope, p.query, 5), pool = await gateway.client.search(mapping.scope, p.query, 32);
      const task = {probe_id: p.id, group_id: s.group_id, dataset: s.dataset, split: s.split,
        query: p.query, question_date: p.question_date ?? null, category: p.category, domain: s.domain ?? null, exclusion: p.exclusion};
      const ref = {...task, answer: p.answer, rubric: p.rubric, gold_ids: p.gold_ids};
      const record = {task, ref, mapping, items: pool.items, native_items: native.items, shard,
        context_prefix: a.context_prefix, native_ms: native.latency_ms, pool_ms: pool.latency_ms};
      const d = prepareV9({...record, scores: pool.items.map(x => ({id: x.id, score: 0}))});
      await appendFile(out + '/records.jsonl', JSON.stringify(record) + '\n');
      await appendFile(out + '/references.jsonl', JSON.stringify(ref) + '\n');
      await appendFile(out + '/native.jsonl', JSON.stringify(view(d, 'native_k5', {items: native.items}, {budget_tokens: null, fallback: false})) + '\n');
      completed++;
    }
    await gateway.stop(); console.log('ingest ' + (shard + 1) + '/' + adapted.length + ' questions=' + completed + ' chunks=' + written);
  }
  await writeFile(out + '/ingest-summary.json', JSON.stringify({status: 'pass', subjects: adapted.length, questions: completed,
    written_chunks: written, inference_started: false, old_results_dependency: false, private_mirror_tested: false}), {flag: 'wx'});
} catch (error) {await writeFile(out + '/INGEST-FAILED.json', JSON.stringify({error: error.stack, completed, written}), {flag: 'wx'}); throw error;}
finally {await gateway.stop();}
