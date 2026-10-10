import {readFile, writeFile, appendFile, mkdir} from 'node:fs/promises';
import {resolve, sep, dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {hash} from '../src/adapters.mjs';
import {FailureAwareReader} from '../src/v10-failure-aware-reader.mjs';
import {LocalReader} from '../src/local-reader.mjs';
import {evaluatePhase} from '../src/ac-evaluation-v1-1.mjs';
import {publicEvaluators} from '../src/ac-public-evaluators.mjs';
if (process.argv.includes('--help')) {console.log('node scripts/ac-eval-v1-1.mjs --views <views.jsonl> --references <references.jsonl> --adapter <longmem|beam|locomo|local .mjs exporting adapter> --phase <reader|judge> --config <config JSON or frozen protocol JSON> --cache <cache directory> --out <new directory> [--answers <reader results.jsonl>] [--failure-cache <directory>]'); process.exit(0);}
const argv = process.argv.slice(2); assert.equal(argv.length % 2, 0);
const args = Object.fromEntries(Array.from({length: argv.length / 2}, (_, i) => [argv[2 * i].replace(/^--/, ''), argv[2 * i + 1]]));
for (const k of ['views', 'references', 'adapter', 'phase', 'config', 'cache', 'out']) assert(args[k], k);
assert(Object.keys(args).every(k => ['views', 'references', 'adapter', 'phase', 'config', 'cache', 'out', 'answers', 'failure-cache'].includes(k)));
assert(['reader', 'judge'].includes(args.phase)); if (args.phase === 'judge') assert(args.answers);
const out = resolve(args.out), cache = resolve(args.cache), cwd = resolve('.');
assert(out.startsWith(cwd + sep) && cache.startsWith(cwd + sep));
const adapter = publicEvaluators[args.adapter] ?? (await import(pathToFileURL(resolve(args.adapter)).href)).adapter;
const rawConfig = JSON.parse(await readFile(args.config, 'utf8')), config = rawConfig.config ?? rawConfig;
const failureDirectory = resolve(args['failure-cache'] ?? out + '/failure-cache'); assert(failureDirectory.startsWith(cwd + sep));
const api = new LocalReader({config, cacheDir: cache}); await api.verify();
const controlled = new FailureAwareReader({api, failureCacheDir: failureDirectory});
const rows = async f => (await readFile(f, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const views = await rows(args.views), references = new Map((await rows(args.references)).map(x => [x.probe_id, x]));
const answers = args.answers ? new Map((await rows(args.answers)).map(x => [x.probe_id + '|' + x.mode, x])) : new Map();
await mkdir(dirname(out), {recursive: true}); await mkdir(out);
const sources = [args.views, args.references, args.config, ...(args.answers ? [args.answers] : []),
  'scripts/ac-eval-v1-1.mjs', 'src/ac-evaluation-v1-1.mjs', 'src/ac-public-evaluators.mjs', 'src/local-reader.mjs', 'src/v10-failure-aware-reader.mjs',
  ...(!publicEvaluators[args.adapter] ? [args.adapter] : [])];
await writeFile(out + '/protocol.json', JSON.stringify({at: new Date().toISOString(), config, adapter: args.adapter, phase: args.phase,
  failure_policy: 'Length-limited Reader responses count as failure; no partial-answer Judge call or retry.', views: views.length, no_implicit_old_results: true, source_hashes: Object.fromEntries(await Promise.all(sources.map(async f => [f, hash(await readFile(f))])))}, null, 2), {flag: 'wx'});
let completed = 0, actual = 0, tokens = 0, correct = 0, failed = 0;
try {
  for await (const r of evaluatePhase({views, references, adapter, phase: args.phase, answers, infer: messages => controlled.infer(messages)})) {
    await appendFile(out + '/results.jsonl', JSON.stringify(r) + '\n'); completed++; correct += r.correct ?? 0; failed += Number(!!r.inference_failed || r.evaluation_status === 'not_run_reader_failed');
    if (r.actual_api_call) {actual++; tokens += r.prompt_tokens + r.output_tokens;}
  }
  await writeFile(out + '/summary.json', JSON.stringify({status: 'pass', views: completed, actual_calls: actual,
    actual_tokens: tokens, inference_failure_views: failed, ...(args.phase === 'judge' ? {correct, accuracy: correct / completed} : {})}), {flag: 'wx'});
} catch (error) {await writeFile(out + '/FAILED.json', JSON.stringify({error: error.stack, completed, telemetry: error.telemetry ?? null}), {flag: 'wx'}); throw error;}
