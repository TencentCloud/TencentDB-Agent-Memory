import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {hash} from './adapters.mjs';

export function inferenceKey(config, messages) {
  return hash(JSON.stringify({adapter: 'ollama-paired-v1', model: config.model, digest: config.digest,
    server_version: config.server_version, options: config.options, think: config.think, messages}));
}

export class LocalReader {
  constructor({config, cacheDir, baseUrl = 'http://127.0.0.1:11434', timeoutMs = 120000, fetchFn = fetch}) {
    const url = new URL(baseUrl);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:') throw Error('local_endpoint_required');
    this.config = config; this.cacheDir = cacheDir; this.baseUrl = baseUrl; this.timeoutMs = timeoutMs; this.fetch = fetchFn;
  }
  async verify() {
    const [tags, version] = await Promise.all(['/api/tags', '/api/version'].map(async path => {
      const r = await this.fetch(this.baseUrl + path, {signal: AbortSignal.timeout(5000)});
      if (!r.ok) throw Error('model_preflight_http'); return r.json();
    }));
    if (tags.models.find(x => x.name === this.config.model)?.digest !== this.config.digest) throw Error('model_digest_changed');
    if (version.version !== this.config.server_version) throw Error('server_version_changed');
  }
  async infer(messages) {
    const c = this.config, bytes = messages.reduce((n, m) => n + Buffer.byteLength(m.content, 'utf8'), 0);
    // Conservative upper bound for the pinned byte-level Qwen tokenizers.
    // Do not silently truncate or select a shorter subset when a view is too long.
    if (bytes + 1024 + c.options.num_predict > c.options.num_ctx) throw Error('context_guard_overflow');
    const key = inferenceKey(c, messages), file = join(this.cacheDir, key + '.json');
    try {
      const record = JSON.parse(await readFile(file, 'utf8'));
      if (record.key !== key || record.response_hash !== hash(record.text) || record.config_hash !== hash(JSON.stringify(c))) throw Error('cache_corrupt');
      return {...record, cache_hit: true, elapsed_ms: 0};
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const request = {model: c.model, messages, stream: false, think: c.think, options: c.options, keep_alive: '5m'};
    const started = performance.now();
    const response = await this.fetch(this.baseUrl + '/api/chat', {method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify(request), signal: AbortSignal.timeout(this.timeoutMs)});
    if (!response.ok) throw Error('reader_http_' + response.status);
    const raw = await response.json(), text = raw.message?.content;
    if (raw.model !== c.model || raw.done !== true || typeof text !== 'string' || !text.trim()) throw Error('reader_response_schema');
    if (raw.done_reason !== 'stop') {
      const error = Error('reader_not_finished_' + raw.done_reason);
      // Preserve failed-call cost and partial output for audit, never in success cache.
      error.telemetry = {key, model: c.model, done_reason: raw.done_reason, text,
        prompt_tokens: raw.prompt_eval_count, output_tokens: raw.eval_count, elapsed_ms: performance.now() - started};
      throw error;
    }
    if (!Number.isInteger(raw.prompt_eval_count) || !Number.isInteger(raw.eval_count)) throw Error('missing_usage');
    if (raw.prompt_eval_count + raw.eval_count >= c.options.num_ctx) throw Error('context_capacity_reached');
    const record = {key, config_hash: hash(JSON.stringify(c)), model: c.model, model_digest: c.digest, text,
      response_hash: hash(text), created_at: new Date().toISOString(), cache_hit: false,
      elapsed_ms: performance.now() - started, prompt_tokens: raw.prompt_eval_count, output_tokens: raw.eval_count,
      load_ms: raw.load_duration / 1e6, prompt_eval_ms: raw.prompt_eval_duration / 1e6, eval_ms: raw.eval_duration / 1e6,
      done_reason: raw.done_reason, thinking_present: !!raw.message.thinking};
    await mkdir(this.cacheDir, {recursive: true});
    await writeFile(file, JSON.stringify(record, null, 2), {flag: 'wx'});
    return record;
  }
}
