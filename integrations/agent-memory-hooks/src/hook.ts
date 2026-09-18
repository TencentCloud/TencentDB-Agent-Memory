import { parseArgs } from 'node:util';
import { configDefault, Memory } from './memory.js';

let diagnostic = false;
try {
  const { values } = parseArgs({ options: {
    config: { type: 'string', default: configDefault }, adapter: { type: 'string', default: 'standard' },
    query: { type: 'string' }, check: { type: 'boolean' }, status: { type: 'boolean' }, 'retry-one': { type: 'boolean' },
  } });
  diagnostic = values.query !== undefined || !!(values.check || values.status || values['retry-one']);
  if (!/^[a-z][a-z0-9_]*$/.test(values.adapter)) throw new Error('Invalid adapter');
  const adapter = await import(`./adapters/${values.adapter}.js`);
  const memory = new Memory(values.config, values.adapter);
  if (values.query !== undefined) {
    if (!values.query.trim()) throw new Error('Empty query');
    console.log(JSON.stringify({ context: await memory.recall(values.query.trim()) }));
  } else if (values.status) console.log(JSON.stringify(memory.status()));
  else if (values.check) {
    const identity = await memory.identity('read');
    await memory.identity('write');
    await memory.post('/v3/conversation/count', identity);
    console.log('Memory identity, read/write permissions and data-plane authentication OK');
  } else if (values['retry-one']) console.log(await memory.retry() ? 'Retried one turn' : 'No pending turns');
  else {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 1024 * 1024) throw new Error('Input too large');
      chunks.push(chunk);
    }
    const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid event');
    const event = adapter.normalize(raw);
    console.log(JSON.stringify(adapter.encode(await memory.handle(event), event)));
  }
} catch {
  // Never print prompts, response bodies, credentials or exception messages.
  console.error('Agent Memory unavailable');
  if (diagnostic) process.exitCode = 1;
  else console.log('{}');
}
