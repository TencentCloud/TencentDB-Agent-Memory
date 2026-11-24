import {readFile, writeFile, appendFile, mkdir} from 'node:fs/promises';
import {resolve, sep, dirname} from 'node:path';
import assert from 'node:assert/strict';
import {QwenRuntimeV10} from '../src/v10-qwen-runtime-v1-1.mjs';
import {hash} from '../src/adapters.mjs';
if (process.argv.includes('--help')) {console.log('node scripts/ac-score.mjs --records <canonical records.jsonl> --out <new directory> --runtime <scorer log directory>'); process.exit(0);}
const argv = process.argv.slice(2); assert.equal(argv.length % 2, 0);
const args = Object.fromEntries(Array.from({length: argv.length / 2}, (_, i) => [argv[2 * i].replace(/^--/, ''), argv[2 * i + 1]]));
assert.deepEqual(Object.keys(args).sort(), ['out', 'records', 'runtime']);
const out = resolve(args.out), runtime = resolve(args.runtime), cwd = resolve('.');
assert(out.startsWith(cwd + sep) && runtime.startsWith(cwd + sep));
await mkdir(dirname(out), {recursive: true}); await mkdir(out);
const sources = [args.records, 'scripts/ac-score.mjs', 'scripts/v10-qwen-server.py', 'src/v10-qwen-runtime.mjs',
  'src/v10-qwen-runtime-v1-1.mjs', 'runtime/models/qwen3-reranker-06b-v9/manifest.json'];
await writeFile(out + '/protocol.json', JSON.stringify({at: new Date().toISOString(), command: 'score', dataset_specific_schema: false,
  model_revision: 'e61197ed45024b0ed8a2d74b80b4d909f1255473', candidate_limit: 64, no_fitting: true,
  source_hashes: Object.fromEntries(await Promise.all(sources.map(async f => [f, hash(await readFile(f))])))}, null, 2), {flag: 'wx'});
const records = (await readFile(args.records, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
assert(records.length > 0 && records.length <= 10000);
assert(records.every(r => ['train', 'development', 'calibration'].includes(r.task.split)));
const engine = new QwenRuntimeV10(runtime); let completed = 0;
try {
  await engine.start();
  for (const r of records) {
    const score = await engine.score(r.task.query, r.items, r.mapping);
    await appendFile(out + '/scores.jsonl', JSON.stringify({probe_id: r.task.probe_id, ...score}) + '\n');
    const all = [...new Map([...r.items, ...r.native_items].map(x => [x.id, x])).values()];
    const accepted = Object.fromEntries(all.map(x => [x.id, r.mapping.accepted[x.id]]));
    const turns = Object.fromEntries([...new Set(all.map(x => accepted[x.id].turn_id))].map(id => [id, r.mapping.turns[id]]));
    await appendFile(out + '/bundle.jsonl', JSON.stringify({task: r.task, ref: r.ref, items: r.items, native_items: r.native_items,
      scores: score.scores, mapping: {accepted, turns}, context_prefix: r.context_prefix ?? ''}) + '\n');
    completed++;
  }
  await writeFile(out + '/summary.json', JSON.stringify({status: 'pass', questions: completed, model_startup_ms: engine.startup_ms}), {flag: 'wx'});
} catch (error) {await writeFile(out + '/FAILED.json', JSON.stringify({error: error.stack, completed}), {flag: 'wx'}); throw error;}
finally {await engine.stop();}
