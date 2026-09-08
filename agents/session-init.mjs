#!/usr/bin/env node
// Session-local Claude Code launcher. Reuses Panel metadata and Proxy header preselection.
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface, emitKeypressEvents } from 'node:readline';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const clean = (value) => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
const accent = (text) => process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[36m${text}\x1b[0m` : text;

export async function choose(title, options, plain = false) {
  if (!options.length) throw new Error(`${title}：没有可用选项，请先在面板中创建或申请权限。`);
  console.log(`\n  ${title}`);
  if (plain || !process.stdin.isTTY || !process.stdout.isTTY) {
    options.forEach((option, i) => console.log(`    ${i + 1}. ${clean(option.name)}`));
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await new Promise((resolve, reject) => {
        rl.setPrompt('  选择编号（q 取消）› ');
        rl.prompt();
        rl.on('line', (line) => {
          if (line.trim() === 'q') return reject(new Error('已取消。'));
          const index = Number(line.trim()) - 1;
          if (line.trim() && Number.isInteger(index) && options[index]) resolve(options[index]);
          else rl.prompt();
        });
        rl.on('close', () => reject(new Error('已取消。')));
      });
    } finally { rl.close(); }
  }
  let selected = 0;
  const render = () => process.stdout.write(`\r\x1b[2K${accent(`    › ${clean(options[selected].name)}  (${selected + 1}/${options.length})`)}`);
  console.log('  ↑↓ 选择 · Enter 确认 · Esc 取消');
  emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    return await new Promise((resolve, reject) => {
      const onKey = (_text, key = {}) => {
        if (key.name === 'escape' || key.name === 'c' && key.ctrl) finish(new Error('已取消。'));
        else if (key.name === 'return') finish();
        else if (key.name === 'up' || key.name === 'down') {
          selected = (selected + (key.name === 'up' ? -1 : 1) + options.length) % options.length;
          render();
        }
      };
      const finish = (error) => {
        process.stdin.removeListener('keypress', onKey);
        process.stdout.write('\n');
        error ? reject(error) : resolve(options[selected]);
      };
      process.stdin.on('keypress', onKey);
      render();
    });
  } finally {
    process.stdin.setRawMode(wasRaw ?? false);
    process.stdin.pause();
  }
}

// Same paginated Panel contract as setup-proxy.sh / Panel metaListAll; no Core admin key.
export function metadata(panel, instance, userKey) {
  const url = new URL(panel);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Panel 地址必须是 HTTP(S) 地址，不能包含凭据。');
  const post = async (action, body) => {
    const response = await fetch(`${panel.replace(/\/+$/, '')}/api/v1/meta/${action}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', 'x-tdai-service-id': instance, 'x-tdai-user-key': userKey },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Panel ${action}：HTTP ${response.status}，请检查地址、身份与权限。`);
    const result = await response.json();
    if (result.code !== 0 || !result.data) throw new Error(`Panel ${action}：业务错误 ${result.code ?? 'unknown'}。`);
    return result.data;
  };
  return {
    verify: () => post('auth/verify', { user_key: userKey }),
    list: async (action, body) => {
      const items = [];
      for (let offset = 0; offset < 100000; offset += 100) {
        const page = await post(action, { ...body, offset, limit: 100 });
        if (!Array.isArray(page.items)) throw new Error(`Panel ${action}：列表格式不正确。`);
        items.push(...page.items);
        if (typeof page.total === 'number' ? offset + 100 >= page.total : page.items.length === 0) return items;
      }
      throw new Error('目录过大，请在面板中检查列表后重试。');
    },
  };
}

export function sessionHeaders(existing, team, agent, task) {
  // Replace only identity headers; never retain a stale task or pinned session ID.
  const lines = (existing ?? '').split(/\r?\n/).filter((line) => line.trim() &&
    !/^(x-team-id|x-agent-id|x-task-id|x-session-id|x-conversation-id|x-claude-code-session-id)\s*:/i.test(line.trim()));
  for (const id of [team, agent, task]) if (id && /[\r\n]/.test(id)) throw new Error('身份 ID 格式不正确。');
  lines.push(`x-team-id: ${team}`, `x-agent-id: ${agent}`);
  if (task) lines.push(`x-task-id: ${task}`);
  return lines.join('\n');
}

export async function launch(executable, args, env) {
  const dir = mkdtempSync(join(tmpdir(), 'tdai-session-'));
  const settings = join(dir, 'settings.json');
  try {
    writeFileSync(settings, JSON.stringify({ env }), { mode: 0o600 });
    return await new Promise((resolve, reject) => {
      const child = spawn(executable, ['--settings', settings, ...args], { stdio: 'inherit', env: { ...process.env, ...env } });
      const interrupt = () => child.kill('SIGINT');
      const terminate = () => child.kill('SIGTERM');
      const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
      process.on('SIGINT', interrupt);
      process.on('SIGTERM', terminate);
      child.on('error', () => { cleanup(); reject(new Error('无法启动 Claude Code，请检查安装及 PATH。')); });
      child.on('exit', (code, signal) => { cleanup(); resolve(code ?? (signal ? 130 : 1)); });
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function main() {
  const { values } = parseArgs({ options: {
    panel: { type: 'string', default: process.env.TDAI_PANEL_URL ?? 'http://127.0.0.1:8125' },
    settings: { type: 'string', default: join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json') },
    model: { type: 'string' }, prompt: { type: 'string' },
    plain: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('用法：node agents/session-init.mjs [--panel URL] [--settings FILE] [--model ID] [--prompt TEXT] [--plain]\n复用已配置的 Claude Code，选择团队 / Agent / 可选任务后启动新会话。\n需要 Proxy 开启 sessionInit 和默认名称的 headerAutoSelect；首次接入请先运行 agents/setup-proxy.sh。');
    return;
  }
  let config;
  try { config = JSON.parse(readFileSync(resolve(values.settings), 'utf8')); }
  catch { throw new Error('无法读取 Claude Code 配置，请先运行 agents/setup-proxy.sh，或用 --settings 指定配置文件。'); }
  const env = { ...config.env };
  const base = env.ANTHROPIC_BASE_URL;
  const key = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
  let endpoint;
  try { endpoint = new URL(base); } catch { throw new Error('Claude Code 尚未配置 MemoryProxy 地址。'); }
  const match = endpoint.pathname.match(/^\/claude-code\/([^/]+)\/?$/);
  if (!match || !['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !key) {
    throw new Error('需要 /claude-code/<实例> 接入地址和 User Key，请先运行 agents/setup-proxy.sh。');
  }
  console.log(accent('\n  Agent Memory · 开始会话'));
  console.log(`  Claude Code · ${clean(endpoint.host)}\n  仅影响本次新会话，不修改全局配置。`);
  const api = metadata(values.panel, decodeURIComponent(match[1]), key);
  const user = await api.verify();
  if (!user.user?.user_id) throw new Error('认证未返回有效用户。');
  const team = await choose('选择团队', await api.list('team/list', { user_id: user.user.user_id }), values.plain);
  const agent = await choose('选择 Agent', await api.list('agent/list', { team_id: team.team_id, status: 'active' }), values.plain);
  const tasks = await api.list('task/list', { team_id: team.team_id });
  const task = await choose('关联任务（可选）', [{ name: '不关联任务' }, ...tasks.map((t) => ({ ...t, name: t.name || t.title || t.task_id }))], values.plain);
  const model = values.model || env.ANTHROPIC_MODEL || config.model;
  env.ANTHROPIC_CUSTOM_HEADERS = sessionHeaders(env.ANTHROPIC_CUSTOM_HEADERS, team.team_id, agent.agent_id, task.task_id);
  if (model) env.ANTHROPIC_MODEL = model;
  console.log(`\n  团队    ${clean(team.name)}\n  Agent   ${clean(agent.name)}\n  任务    ${clean(task.name)}\n  模型    ${clean(model || '沿用客户端默认值')}`);
  const action = await choose('准备就绪，启动后由 Proxy 校验并完成绑定', [{ name: '启动 Claude Code', start: true }, { name: '取消' }], values.plain);
  if (!action.start) return;
  const args = model ? ['--model', model] : [];
  if (values.plain) args.push('--ax-screen-reader');
  if (values.prompt) args.push('--', values.prompt);
  process.exitCode = await launch('claude', args, env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`\n  ${clean(error.message)}\n  未修改全局 Claude 配置，可重新运行。`);
    process.exitCode = 1;
  });
}
