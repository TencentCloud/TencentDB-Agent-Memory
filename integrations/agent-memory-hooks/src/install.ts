import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { configDefault, expand, privateWrite, quote } from './memory.js';

type Entry = { type?: string; command?: string; args?: string[]; [key: string]: unknown };
type Group = { hooks: Entry[]; [key: string]: unknown };
export { quote } from './memory.js';
// Native Windows command-line quoting; reject shell expansions on Windows rather than misexecute paths.
const windowsQuote = (s: string): string => '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';

export function install(settings: string, config: string, client: 'zcode' | 'codex', remove = false): boolean {
  settings = expand(settings);
  config = expand(config);
  if (remove && !existsSync(settings)) return false;
  const original = existsSync(settings) ? readFileSync(settings, 'utf8') : '{}';
  const data = JSON.parse(original);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid settings');
  if (remove && !data.hooks) return false;
  const hooks = data.hooks ??= {};
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) throw new Error('Invalid hooks');
  if (client === 'zcode' && !remove && hooks.enabled === false) throw new Error('Hooks explicitly disabled');
  const events = client === 'zcode' ? (hooks.events ??= {}) : hooks;
  const script = fileURLToPath(new URL('./hook.js', import.meta.url));
  const legacy = join(dirname(dirname(script)), 'hook.py');
  const argv = [process.execPath, script, '--adapter', client, '--config', config];
  if (process.platform === 'win32' && argv.some(x => /[%!\r\n]/.test(x))) throw new Error('Unsupported Windows shell path');
  if (!remove && !existsSync(script)) throw new Error('Build hooks before installing');
  const owned = (entry: Entry): boolean => client === 'zcode'
    ? entry.type === 'process' && [script, legacy].includes(entry.args?.[0] ?? '')
    : entry.type === 'command' && [script, legacy].some(path =>
      entry.command?.includes(` ${quote(path)} --adapter ${client} `));
  for (const name of ['UserPromptSubmit', 'Stop']) {
    const groups: Group[] = events[name] ?? [];
    const kept = groups.map(group => ({ ...group, hooks: group.hooks.filter(entry => !owned(entry)) }))
      .filter(group => group.hooks.length);
    if (!remove) kept.push({ hooks: [client === 'zcode'
      ? { type: 'process', command: argv[0], args: argv.slice(1), timeoutMs: 10000, enabled: true }
      : { type: 'command', command: argv.map(quote).join(' '), commandWindows: argv.map(windowsQuote).join(' '), timeout: 10 }] });
    events[name] = kept;
  }
  if (!remove && client === 'zcode') hooks.enabled = true;
  if (JSON.stringify(data) === JSON.stringify(JSON.parse(original))) return false;
  if (existsSync(settings)) privateWrite(`${settings}.${process.hrtime.bigint()}.bak`, original);
  privateWrite(settings, JSON.stringify(data, null, 2) + '\n');
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(expand(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: {
      client: { type: 'string' }, settings: { type: 'string' },
      config: { type: 'string', default: configDefault }, remove: { type: 'boolean' },
    } });
    if (values.client !== 'zcode' && values.client !== 'codex') throw new Error('Choose --client zcode or codex');
    const settings = values.settings ?? join(homedir(), values.client === 'codex' ? '.codex/hooks.json' : '.zcode/cli/config.json');
    console.log(install(settings, values.config, values.client, values.remove) ? 'Updated' : 'Unchanged');
  } catch {
    console.error('Installation failed; check client, settings and build output');
    process.exitCode = 1;
  }
}
