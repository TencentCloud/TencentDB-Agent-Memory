import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {hash} from './adapters.mjs';
import {inferenceKey} from './local-reader.mjs';
// A failed generation is retained separately from successful inference cache entries.
export class FailureAwareReader {
  constructor({api, failureCacheDir, priorFailures = []}) {this.api = api; this.config = api.config; this.directory = failureCacheDir; this.prior = new Map(priorFailures.map(x => [x.key, x]));}
  validate(r, key) {
    if (r.key !== key || r.config_hash !== hash(JSON.stringify(this.config)) || r.model_digest !== this.config.digest
      || r.done_reason !== 'length' || r.output_tokens !== this.config.options.num_predict || !Number.isInteger(r.prompt_tokens)
      || r.prompt_tokens < 0 || typeof r.text !== 'string' || hash(r.text) !== r.response_hash || r.inference_failed !== true) throw Error('failed_request_binding');
  }
  async infer(messages) {
    const key = inferenceKey(this.config, messages), file = join(this.directory, key + '.json');
    try {const r = JSON.parse(await readFile(file, 'utf8')); this.validate(r, key);
      return {...r, cache_hit: true, cache_origin: 'failure_cache', actual_api_call: false, elapsed_ms: 0};
    } catch (error) {if (error.code !== 'ENOENT') throw error;}
    if (this.prior.has(key)) {
      const r = this.prior.get(key); this.validate(r, key); await mkdir(this.directory, {recursive: true});
      await writeFile(file, JSON.stringify(r, null, 2), {flag: 'wx'});
      return {...r, cache_hit: true, cache_origin: 'prior_failure_replay', actual_api_call: false, elapsed_ms: 0};
    }
    try {const r = await this.api.infer(messages); return {...r, inference_failed: false, actual_api_call: !r.cache_hit};}
    catch (error) {
      const t = error.telemetry;
      if (error.message !== 'reader_not_finished_length' || t?.done_reason !== 'length') throw error;
      const r = {...t, key, config_hash: hash(JSON.stringify(this.config)), model_digest: this.config.digest,
        response_hash: hash(t.text), created_at: new Date().toISOString(), inference_failed: true,
        failure_type: 'generation_length_limit', thinking_present: false, status: 'failed'};
      this.validate(r, key); await mkdir(this.directory, {recursive: true});
      await writeFile(file, JSON.stringify(r, null, 2), {flag: 'wx'});
      return {...r, cache_hit: false, cache_origin: 'new_failed_call', actual_api_call: true};
    }
  }
}
