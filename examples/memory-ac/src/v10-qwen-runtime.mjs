import {mkdir} from 'node:fs/promises';
import {openSync, closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
const revision = 'e61197ed45024b0ed8a2d74b80b4d909f1255473';
export class QwenRuntimeV10 {
  constructor(directory, {testFaults = false} = {}) {this.directory = directory; this.testFaults = testFaults; this.base = 'http://127.0.0.1:18431';}
  async health() {
    const r = await fetch(this.base + '/health', {signal: AbortSignal.timeout(500)});
    const data = await r.json(); if (!r.ok || data.revision !== revision) throw Error('qwen_health'); return data;
  }
  async start() {
    let occupied = false; try {await fetch(this.base + '/health', {signal: AbortSignal.timeout(500)}); occupied = true;} catch {}
    if (occupied) throw Error('qwen_port_occupied');
    await mkdir(this.directory, {recursive: true}); const started = performance.now();
    this.fd = openSync(resolve(this.directory, 'qwen-' + Date.now() + '.log'), 'a');
    this.startError = null;
    this.child = spawn(resolve('runtime/v9-python/Scripts/python.exe'), ['scripts/v10-qwen-server.py'],
      {windowsHide: true, stdio: ['ignore', this.fd, this.fd], env: {...process.env, V10_TEST_FAULTS: this.testFaults ? '1' : '0'}});
    this.child.once('error', error => {this.startError = error;});
    try {
      for (let i = 0; i < 180; i++) {
        if (this.startError || this.child.exitCode !== null) throw Error('qwen_start_failed');
        try {const h = await this.health(); this.startup_ms = performance.now() - started; return h;} catch {}
        await new Promise(r => setTimeout(r, 500));
      }
      throw Error('qwen_start_timeout');
    } catch (error) {await this.stop(); throw error;}
  }
  async stop() {
    const child = this.child; this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      let timer;
      try {await new Promise((resolve, reject) => {
        child.once('exit', resolve); child.kill();
        timer = setTimeout(() => reject(Error('qwen_process_termination_timeout')), 5000);
      });} finally {clearTimeout(timer);}
    }
    if (this.fd !== undefined) {closeSync(this.fd); this.fd = undefined;}
  }
  async score(query, items, mapping, {signal, timeoutMs = 5000, fault} = {}) {
    if (!this.child || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000
      || items.length > 64 || (fault && !this.testFaults)) throw Error('qwen_request_bounds');
    const started = performance.now();
    const body = {query, items: items.map(x => ({id: x.id, content: x.content, role: x.role,
      date: mapping.accepted[x.id]?.source_date})), ...(fault ? {fault} : {})};
    try {
      const response = await fetch(this.base + '/score', {method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)});
      if (!response.ok) throw Error('qwen_http_rejected');
      const r = await response.json(), scores = new Map(r.scores?.map(x => [x.id, x.score]));
      if (r.revision !== revision || scores.size !== items.length || items.some(x => !Number.isFinite(scores.get(x.id)))) throw Error('qwen_response_schema');
      return {...r, wall_ms: performance.now() - started};
    } catch (error) {
      // Kill only this runtime's owned scorer, so a timed-out GPU job cannot accumulate.
      await this.stop();
      throw Error(signal?.aborted ? 'qwen_aborted_process_stopped' : 'qwen_failed_process_stopped', {cause: error});
    }
  }
}
