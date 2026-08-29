import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';


let KIND = 'openclaw';
// 以下为本文件内联的共享扫盘工具与导入引擎（原 MemoryPanel/scripts/asset-import/*）。
// 仅依赖 Node 内置模块；与公共 CLI 行为保持一致。
// ════════════════════════════════════════════════════════════════════════════

// ── 类型 ──
type AgentKind = string;
interface ScannedSkill {
  name: string;
  content: string;
  resources: { path: string; content: string }[];
  sourceKey: string;
}
interface ScannedMemoryFile {
  messages: { role: 'user'; content: string }[];
  sourceKey: string;
  origin: string;
}
/** 从 session 文本提取时间范围与项目路径（字段名自适应，找不到则留空）。 */
function extractSessionMeta(text: string): { timeRange: string; projectPath: string } {
  const ts: number[] = [];
  let cwd = '';
  const TS_KEYS = new Set(['ts', 'timestamp', 'time', 'created_at', 'starttime', 'endtime', 'sentat', 't']);
  const CWD_KEYS = new Set(['cwd', 'project', 'projectpath', 'workingdir', 'workingdirectory', 'repo', 'workspace']);
  const walk = (o: unknown): void => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const key = k.toLowerCase();
      if (TS_KEYS.has(key)) {
        let d = NaN;
        if (typeof v === 'string') d = Date.parse(v);
        else if (typeof v === 'number') d = v < 1e12 ? v * 1000 : v;
        if (!Number.isNaN(d)) ts.push(d);
      }
      if (!cwd && CWD_KEYS.has(key) && typeof v === 'string' && v.trim()) cwd = v.trim();
      if (typeof v === 'object' && v !== null) walk(v);
    }
  };
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { walk(JSON.parse(t)); } catch { /* 跳过非 JSON 行 */ }
  }
  let timeRange = '';
  if (ts.length) {
    ts.sort((a, b) => a - b);
    const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
    timeRange = ts.length === 1 ? fmt(ts[0]) : `${fmt(ts[0])} ~ ${fmt(ts[ts.length - 1])}`;
  }
  return { timeRange, projectPath: cwd };
}

interface ScannedSession {
  sessionId: string;
  messages: { role: string; content: string; ts?: number; hasToolUse?: boolean }[];
  sourceKey: string;
  origin: string;
}
interface ScanOptions {
  workspace?: string;
}

// ── 跨源共享扫盘工具（原 scan-util.ts）──
export function workspaceRoot(opts?: ScanOptions): string | undefined {
  if (!opts?.workspace?.trim()) return undefined;
  const ws = resolve(opts.workspace.trim());
  if (!existsSync(ws) || !statSync(ws).isDirectory()) {
    throw new Error(`--workspace 不是有效目录: ${ws}`);
  }
  return ws;
}

export function projectCwd(opts?: ScanOptions): string {
  return workspaceRoot(opts) ?? process.cwd();
}

export function gitRootOrCwd(start: string): string {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

export function dirsFromRepoRootToCwd(cwd: string): string[] {
  const root = gitRootOrCwd(cwd);
  const acc: string[] = [];
  let dir = resolve(cwd);
  while (true) {
    acc.push(dir);
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return acc.reverse();
}

export function home(): string {
  return homedir();
}

export function expandHomePath(p: string): string {
  return resolve(p.replace(/^~(?=\/|$)/, home()));
}

export function readIfExists(p: string): string | null {
  try {
    if (!existsSync(p)) return null;
    return readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

export function listMd(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(dir, f));
}

export function walkFiles(dir: string, pred: (name: string) => boolean): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walkFiles(full, pred));
    else if (st.isFile() && pred(name)) out.push(full);
  }
  return out;
}

export function listMdRecursive(dir: string): string[] {
  return walkFiles(dir, (name) => name.endsWith('.md'));
}

export function listJsonlRecursive(dir: string): string[] {
  return walkFiles(dir, (name) => name.endsWith('.jsonl'));
}

export function skillNameFromContent(fallback: string, content: string): string {
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
  const n = fm?.[1].match(/^name:\s*(.+)\s*$/m);
  if (!n) return fallback;
  return n[1].trim().replace(/^['"]|['"]$/g, '') || fallback;
}

export function collectSubfiles(skillDir: string, rel: string, acc: { path: string; content: string }[]): void {
  const full = join(skillDir, rel);
  if (!existsSync(full)) return;
  const st = statSync(full);
  if (st.isDirectory()) {
    for (const child of readdirSync(full)) {
      collectSubfiles(skillDir, join(rel, child), acc);
    }
  } else if (st.isFile()) {
    const text = readFileSync(full, 'utf-8');
    acc.push({ path: rel.split('\\').join('/'), content: text });
  }
}

const DEFAULT_SKILL_SUBDIRS = ['scripts', 'references', 'assets', 'agents'];

/** 一层 `<name>/SKILL.md` 目录（name 用目录名，不读 frontmatter）。 */
export function collectSkillDirs(kind: AgentKind, roots: string[], subdirs = DEFAULT_SKILL_SUBDIRS): ScannedSkill[] {
  const out: ScannedSkill[] = [];
  const seenRoots = new Set<string>();
  for (const root of roots) {
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);
    if (!existsSync(root) || !statSync(root).isDirectory()) continue;
    for (const entry of readdirSync(root)) {
      if (entry.startsWith('.')) continue;
      const skillDir = join(root, entry);
      if (!statSync(skillDir).isDirectory()) continue;
      const text = readIfExists(join(skillDir, 'SKILL.md'));
      if (text == null) continue;
      const resources: { path: string; content: string }[] = [];
      for (const sub of subdirs) collectSubfiles(skillDir, sub, resources);
      out.push({ name: entry, content: text, resources, sourceKey: `skill:${kind}:${join(root, entry)}` });
    }
  }
  return out;
}

export function memoryFilesFromPaths(kind: AgentKind, files: string[]): ScannedMemoryFile[] {
  const out: ScannedMemoryFile[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f)) continue;
    seen.add(f);
    const text = readIfExists(f);
    if (text == null || !text.trim()) continue;
    out.push({ messages: [{ role: 'user', content: text }], sourceKey: `memory:${kind}:${f}`, origin: f });
  }
  return out;
}

export function isHarnessNoise(role: string, content: string): boolean {
  if (role === 'developer' || role === 'system') return true;
  const t = content.trimStart();
  return (
    t.startsWith('<environment_context>') ||
    t.startsWith('<permissions') ||
    t.startsWith('<plugins_instructions>') ||
    t.startsWith('<skills_instructions>') ||
    t.startsWith('<turn_aborted>') ||
    t.startsWith('# AGENTS.md instructions') ||
    t.startsWith('<system-reminder>') ||
    t.startsWith('Current runtime context')
  );
}

/**
 * 把工具入参对象转成字符串（skill 链路作为结构化 content；也用于 memory 扁平文本）。
 */
function argsToString(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw === 'string') return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

/** 从 tool_result 的 content（string / block 数组 / 嵌套对象）抽出纯文本。 */
function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(blockText).filter(Boolean).join('\n');
  if (content && typeof content === 'object') {
    const c = (content as Record<string, unknown>).content;
    if (c !== undefined) return blockText(c);
    const tx = (content as Record<string, unknown>).text;
    if (typeof tx === 'string') return tx;
  }
  return '';
}

const strVal = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * 一条内容片段（结构化，供 skill 链路 /v3/skill/conversation/add 使用）。
 * - role 缺省时由调用方按记录角色补 user/assistant；
 * - tool_call / tool_result 自带 role 与 tool_call_id（core 要求的配对锚点，缺失会被 40001 拒绝）。
 */
interface ContentFrag {
  role?: string;
  content: string;
  tool_call_id?: string;
  tool_name?: string;
}

/** 展开单个 content block；嵌套 content 数组会递归。 */
function expandBlock(b: unknown): ContentFrag[] {
  if (typeof b === 'string') return [{ content: b }];
  if (b && typeof b === 'object') {
    const bb = b as Record<string, unknown>;
    const type = typeof bb.type === 'string' ? bb.type : '';
    switch (type) {
      // openclaw 工具调用：{type:'toolCall', id, name, arguments}
      case 'toolCall':
        return [{ role: 'tool_call', tool_call_id: strVal(bb.id), tool_name: strVal(bb.name) || 'unknown', content: (argsToString(bb.arguments ?? bb.input) as string) ?? '' }];
      // anthropic / claude / codex / dsh / hermes 工具调用：{type:'tool_use', id, name, input}
      case 'tool_use':
        return [{ role: 'tool_call', tool_call_id: strVal(bb.id), tool_name: strVal(bb.name) || 'unknown', content: (argsToString(bb.input ?? bb.arguments) as string) ?? '' }];
      // openai responses 工具调用：{type:'function_call', name, arguments(字符串), call_id?}
      case 'function_call':
        return [{ role: 'tool_call', tool_call_id: strVal(bb.call_id) || strVal(bb.id), tool_name: strVal(bb.name) || 'unknown', content: typeof bb.arguments === 'string' ? (bb.arguments as string) : ((argsToString(bb.arguments) as string) ?? '') }];
      // openai 消息级 tool_calls 数组（也可能作为 block.type==='tool_calls' 出现）
      case 'tool_calls': {
        const arr: unknown[] = Array.isArray(bb.tool_calls)
          ? (bb.tool_calls as unknown[])
          : Array.isArray(bb.content)
            ? (bb.content as unknown[])
            : [];
        return arr.map((tc) => {
          const t = tc as Record<string, unknown>;
          const fn = (t.function ?? t) as Record<string, unknown>;
          return {
            role: 'tool_call',
            tool_call_id: strVal(t.id),
            tool_name: strVal(fn.name) || 'unknown',
            content: typeof fn.arguments === 'string' ? (fn.arguments as string) : ((argsToString(fn.arguments) as string) ?? ''),
          } as ContentFrag;
        });
      }
      // anthropic tool_result（在 user content 内）/ openai tool 输出
      case 'tool_result':
        return [{ role: 'tool_result', tool_call_id: strVal(bb.tool_use_id) || strVal(bb.tool_call_id) || strVal(bb.id), tool_name: strVal(bb.toolName) || strVal(bb.name), content: blockText(bb.content) }];
      // openclaw 顶层 toolResult 记录（content 即结果 block）
      case 'toolResult':
        return [{ role: 'tool_result', tool_call_id: strVal(bb.id) || strVal(bb.callId) || strVal(bb.toolCallId), tool_name: strVal(bb.toolName) || strVal(bb.name), content: blockText(bb.content) }];
      default:
        if (typeof bb.text === 'string') return [{ content: bb.text }];
        if (bb.content !== undefined) return expandContent(bb.content);
        return [];
    }
  }
  return [];
}

/** 把一段 content（string / block 数组 / 嵌套对象）展开为有序片段。 */
export function expandContent(content: unknown): ContentFrag[] {
  if (typeof content === 'string') return [{ content }];
  if (Array.isArray(content)) return content.flatMap(expandBlock);
  if (content && typeof content === 'object') {
    const c = (content as Record<string, unknown>).content;
    if (c !== undefined) return expandContent(c);
  }
  return [];
}

/** memory 链路用的扁平文本（还原旧行为：工具以 [tool_call] / [tool_result] 文本并入对话流）。 */
function fragFlatText(f: ContentFrag): string {
  if (f.role === 'tool_call') {
    const one = f.content.replace(/\s+/g, ' ').trim();
    const capped = one.length > 4000 ? `${one.slice(0, 4000)}…` : one;
    return `[tool_call] ${f.tool_name || 'unknown'}(${capped})`;
  }
  if (f.role === 'tool_result') {
    const inner = f.content.replace(/\s+/g, ' ').trim();
    const capped = inner.length > 4000 ? `${inner.slice(0, 4000)}…` : inner;
    return `[tool_result${f.tool_name ? `:${f.tool_name}` : ''}] ${capped}`;
  }
  return f.content;
}

/** 兼容旧调用：返回整段扁平文本（工具以 [tool_call]/[tool_result] 形式并入）。 */
export function extractText(content: unknown): string {
  return expandContent(content).map(fragFlatText).filter(Boolean).join('\n');
}

/** 判断一条原始消息记录是否含 tool_use/tool_calls（与 proxy isFinalAnswer 反向判定：含则为中间态，非 final answer）。 */
function recordHasToolUse(rec: Record<string, unknown>, nested?: Record<string, unknown>): boolean {
  for (const src of [rec, nested]) {
    if (!src) continue;
    const s = src as Record<string, unknown>;
    const tc = s.tool_calls;
    if (Array.isArray(tc) && tc.length > 0) return true;
    const c = s.content;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b && typeof b === 'object') {
          const t = (b as Record<string, unknown>).type;
          if (t === 'tool_use' || t === 'toolCall' || t === 'function_call' || t === 'tool_calls') return true;
        }
      }
    }
  }
  return false;
}

/** 从记录对象中提取时间戳（毫秒）。兼容字符串与数字，识别常见字段名；秒级时间戳自动转毫秒。 */
function extractTimestamp(...cands: unknown[]): number | undefined {
  for (const c of cands) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    for (const k of ['ts', 'timestamp', 'time', 'created_at', 'createdAt', 'datetime', 'date']) {
      const v = o[k];
      if (typeof v === 'number' && Number.isFinite(v)) {
        return v < 1e12 ? Math.round(v * 1000) : v;
      }
      if (typeof v === 'string' && v.trim()) {
        const t = Date.parse(v);
        if (!Number.isNaN(t)) return t;
      }
    }
  }
  return undefined;
}

export function parseJsonlLines(text: string): ImportMessage[] {
  const msgs: ImportMessage[] = [];
  let recIdx = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      let rec: Record<string, unknown> = obj;
      if (obj.type === 'event_msg' || obj.type === 'session_meta' || obj.type === 'turn_context' || obj.type === 'world_state') {
        continue;
      }
      if (obj.type === 'response_item' && obj.payload && typeof obj.payload === 'object') {
        rec = obj.payload as Record<string, unknown>;
        if (rec.type && rec.type !== 'message') continue;
      }
      const nested = rec.message && typeof rec.message === 'object' ? (rec.message as Record<string, unknown>) : undefined;
      const role =
        typeof rec.role === 'string'
          ? rec.role
          : typeof nested?.role === 'string'
            ? nested.role
            : rec.type === 'user' || rec.type === 'assistant'
              ? rec.type
              : '';
      // toolResult / tool 视为 user 轮的一部分（与 claude/codex 中 tool_result 进 user 轮一致）。
      // 其结构化形态由片段 role 表达（tool_result），这里只决定"对话流角色"。
      const outRole = role === 'toolResult' || role === 'tool' ? 'user' : role;
      if (outRole !== 'user' && outRole !== 'assistant') continue;
      const ts = extractTimestamp(rec, nested, obj);
      const frags = expandContent(rec.content ?? nested?.content);
      // openai 消息级 tool_calls（content 为 null 时的工具调用，存于 message.tool_calls）
      const msgToolCalls = (rec.tool_calls ?? nested?.tool_calls) as unknown[] | undefined;
      if (Array.isArray(msgToolCalls)) {
        for (const tc of msgToolCalls) frags.push(expandBlock({ type: 'tool_calls', tool_calls: [tc] })[0]);
      }
      const hasTool = recordHasToolUse(rec, nested);
      let pushedAny = false;
      for (const f of frags) {
        if (f.role === undefined) {
          // 普通文本片段：按记录角色并入对话流
          if (f.content && !isHarnessNoise(outRole, f.content)) {
            msgs.push({
              role: outRole,
              content: f.content,
              ts,
              recIdx,
              memRole: outRole,
              ...(outRole === 'assistant' && hasTool ? { hasToolUse: true } : {}),
            });
            pushedAny = true;
          }
        } else {
          // 工具片段：结构化保留（role=tool_call/tool_result，自带 tool_call_id 配对锚点）
          msgs.push({
            role: f.role,
            content: f.content,
            ts,
            recIdx,
            memRole: outRole,
            ...(f.tool_call_id ? { tool_call_id: f.tool_call_id } : {}),
            ...(f.tool_name ? { tool_name: f.tool_name } : {}),
          });
          pushedAny = true;
        }
      }
      if (pushedAny) recIdx++;
    } catch {
      // 跳过非 JSON 行
    }
  }
  return msgs;
}

export function normalizeResponsesJson(path: string): ImportMessage[] {
  const msgs: ImportMessage[] = [];
  const obj = JSON.parse(readFileSync(path, 'utf-8'));
  const input = obj?.input ?? obj?.messages ?? obj?.response?.output;
  const arr = Array.isArray(input) ? input : [];
  let recIdx = 0;
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    const role = typeof it.role === 'string' ? it.role : (typeof it.type === 'string' && it.type !== 'function_call' ? it.type : '');
    let frags: ContentFrag[] = [];
    if (it.type === 'function_call') {
      frags = expandBlock(it); // openai responses 顶层工具调用
    } else if (role === 'tool' || role === 'toolResult' || role === 'tool_result') {
      // openai 原生 tool 角色消息：content 为字符串结果、带 tool_call_id，应作为 tool_result
      // 保留结构化配对（而非退化为纯 user 文本），否则 skill 链路拿不到 tool_result、memory 链路不标 [tool_result]。
      // 注意 expandBlock 返回数组，直接赋值（与 function_call 分支一致，勿再包一层 []）。
      frags = expandBlock({ type: 'tool_result', tool_use_id: it.tool_call_id ?? it.toolCallId, name: it.name ?? it.toolName, content: it.content });
    } else if (Array.isArray(it.content)) {
      frags = expandContent(it.content);
    } else if (typeof it.content === 'string') {
      frags = [{ content: it.content }];
    } else if (typeof it.text === 'string') {
      frags = [{ content: it.text }];
    }
    // openai 消息级 tool_calls
    if (Array.isArray(it.tool_calls)) {
      for (const tc of it.tool_calls) frags.push(expandBlock({ type: 'tool_calls', tool_calls: [tc] })[0]);
    }
    if (frags.length === 0) continue;
    const outRole = role === 'tool' || role === 'toolResult' ? 'user' : role || 'assistant';
    const hasTool = frags.some((f) => f.role === 'tool_call');
    let pushed = false;
    for (const f of frags) {
      if (f.role === undefined) {
        if (f.content && !isHarnessNoise(outRole, f.content)) {
          msgs.push({
            role: outRole,
            content: f.content,
            recIdx,
            memRole: outRole,
            ...(outRole === 'assistant' && hasTool ? { hasToolUse: true } : {}),
          });
          pushed = true;
        }
      } else {
        msgs.push({
          role: f.role,
          content: f.content,
          recIdx,
          memRole: outRole,
          ...(f.tool_call_id ? { tool_call_id: f.tool_call_id } : {}),
          ...(f.tool_name ? { tool_name: f.tool_name } : {}),
        });
        pushed = true;
      }
    }
    if (pushed) recIdx++;
  }
  return msgs;
}

export function extractCodexSessionId(full: string, text: string): string {
  for (const line of text.split('\n').slice(0, 8)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      if (obj.type !== 'session_meta') continue;
      const payload = obj.payload && typeof obj.payload === 'object' ? (obj.payload as Record<string, unknown>) : undefined;
      const sid = payload?.session_id ?? payload?.id ?? obj.session_id;
      if (typeof sid === 'string' && sid.trim()) return sid.trim();
    } catch {
      // 继续扫后续行
    }
  }
  const base = basename(full, '.jsonl');
  const uuid = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  return uuid ? uuid[0] : base;
}

/** `--sessions` 指向已存在目录/文件时的通用覆盖扫描（jsonl + Responses json）。 */


export function readJsonObject(p: string): Record<string, unknown> | null {
  const text = readIfExists(p);
  if (!text) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ── 导入引擎：配置与 HTTP 客户端 ──
interface PanelEnvelope<T = unknown> {
  code: number;
  message?: string;
  request_id?: string;
  data?: T;
}

interface ClientConfig {
  /** panel 基地址，如 http://127.0.0.1:8123 */
  panelUrl: string;
  /** 实例 spaceId */
  serviceId: string;
  /** per-user apikey（X-Tdai-User-Key） */
  userKey: string;
}

/** 从环境变量读取配置；缺失即报错（不静默给默认值）。 */
export async function loadConfigFromEnv(interactive: boolean = true): Promise<ClientConfig> {
  const panelUrl = process.env.PANEL_URL?.trim();
  const serviceId = process.env.TDAI_SERVICE_ID?.trim();
  const userKey = process.env.TDAI_USER_KEY?.trim();
  const missing: string[] = [];
  if (!panelUrl) missing.push('PANEL_URL');
  if (!serviceId) missing.push('TDAI_SERVICE_ID');
  if (!userKey) missing.push('TDAI_USER_KEY');
  if (missing.length > 0) {
    // 三个环境变量都没设且在交互终端：逐个询问用户输入
    if (missing.length === 3 && interactive && process.stdin.isTTY) {
      console.log('未检测到必需环境变量，请依次输入（留空将报错退出）：');
      const inputPanel = (await question('PANEL_URL (面板地址, 如 http://127.0.0.1:8123): ')).trim();
      const inputService = (await question('TDAI_SERVICE_ID (spaceId): ')).trim();
      const inputKey = (await question('TDAI_USER_KEY (sk-mem-...): ')).trim();
      process.env.PANEL_URL = inputPanel;
      process.env.TDAI_SERVICE_ID = inputService;
      process.env.TDAI_USER_KEY = inputKey;
      if (!inputPanel || !inputService || !inputKey) {
        throw new Error('PANEL_URL / TDAI_SERVICE_ID / TDAI_USER_KEY 均不可为空，请重新运行并完整输入');
      }
      return { panelUrl: inputPanel, serviceId: inputService, userKey: inputKey };
    }
    throw new Error(`缺少必需环境变量: ${missing.join(', ')}（可在命令前 export，或用 --env-file 指定 .env）`);
  }
  return { panelUrl: panelUrl!, serviceId: serviceId!, userKey: userKey! };
}

export class PanelClient {
  private readonly cfg: ClientConfig;
  constructor(cfg: ClientConfig) {
    this.cfg = cfg;
  }

  /** 唯一写库开关由调用方控制（dryRun 时不应调用 post）。 */
  async post<T = unknown>(path: string, body: unknown): Promise<PanelEnvelope<T>> {
    // panel 路由统一挂在 /api/v1 下；调用方传的路径若未带前缀则自动补上。
    const normPath = path.startsWith('/api/v1') ? path : `/api/v1${path.startsWith('/') ? '' : '/'}${path}`;
    const url = `${this.cfg.panelUrl.replace(/\/$/, '')}${normPath}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tdai-Service-Id': this.cfg.serviceId,
        'X-Tdai-User-Key': this.cfg.userKey,
      },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let json: PanelEnvelope<T>;
    try {
      json = JSON.parse(text) as PanelEnvelope<T>;
    } catch {
      throw new Error(`非 JSON 响应 (${res.status}): ${text.slice(0, 200)}`);
    }
    if (typeof json.code !== 'number') {
      throw new Error(`响应缺少 code 字段 (${res.status}): ${text.slice(0, 200)}`);
    }
    // 业务 envelope（含数字 code）一律返回给调用方判断，不在此抛错。
    return json;
  }

  /** 暴露 serviceId，供 /skill/conversation/add 等需要 space_id 的接口使用。 */
  get serviceId(): string {
    return this.cfg.serviceId;
  }
}

/** 读取可选的 --env-file（dotenv 风格）。 */
export function loadEnvFile(path: string): void {
  try {
    const raw = readFileSync(path, 'utf-8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch (err) {
    throw new Error(`读取 env-file 失败: ${(err as Error).message}`);
  }
}

// ── team / agent 解析（铁律：全程单一 userKey）──
interface AgentRef {
  agentId: string;
  ownerUserId: string;
}

interface PublicUser {
  user_id?: string;
  id?: string;
  username?: string;
  user?: { user_id?: string; id?: string; username?: string };
}

/** 用 userKey 反查真实 user_id（auth/verify 豁免 user-key 校验，body 带 user_key）。 */
async function resolveUserId(client: PanelClient, userKey: string): Promise<string> {
  const env = await client.post<PublicUser>('/meta/auth/verify', {
    user_key: userKey,
  });
  if (env.code !== 0 || !env.data) {
    throw new Error(`auth/verify 失败 code=${env.code} msg=${env.message ?? ''}`);
  }
  const uid =
    (env.data as { user_id?: string }).user_id ??
    (env.data as { id?: string }).id ??
    (env.data as { user?: { user_id?: string } }).user?.user_id;
  if (!uid) throw new Error('auth/verify 未返回 user_id');
  return uid;
}

/** 解析目标 team：给定 id 则校验存在；给定 name 则查重；都没有则报错（不自动建）。 */
async function resolveTeam(
  client: PanelClient,
  userId: string,
  opts: { teamId?: string; teamName?: string },
): Promise<string> {
  if (opts.teamId) {
    const env = await client.post<{ items?: Array<{ team_id: string }> }>('/meta/team/list', {
      user_id: userId,
    });
    if (env.code !== 0) throw new Error(`team/list 失败 code=${env.code} msg=${env.message ?? ''}`);
    const found = (env.data?.items ?? []).find((t) => t.team_id === opts.teamId);
    if (!found) throw new Error(`team_id ${opts.teamId} 不存在或无权限`);
    return opts.teamId!;
  }
  if (opts.teamName) {
    const env = await client.post<{ items?: Array<{ team_id: string; name: string }> }>('/meta/team/list', {
      user_id: userId,
    });
    if (env.code !== 0) throw new Error(`team/list 失败 code=${env.code} msg=${env.message ?? ''}`);
    const found = (env.data?.items ?? []).find((t) => t.name === opts.teamName);
    if (!found) throw new Error(`team「${opts.teamName}」不存在，请先创建或用 --team-id`);
    return found.team_id;
  }
  throw new Error('必须提供 --team-id 或 --team-name');
}

interface ResolveAgentOpts {
  userId: string;
  teamId: string;
  agentId?: string;
  agentName?: string;
}

/** 解析目标 agent：给定 id 校验存在+owner；给定 name 查重；都没有则报错。 */
async function resolveAgent(client: PanelClient, opts: ResolveAgentOpts): Promise<AgentRef> {
  const { userId, teamId } = opts;
  if (opts.agentId) {
    const env = await client.post<AgentRaw>('/meta/agent/get', { agent_id: opts.agentId });
    if (env.code === 404 || (env.code === 0 && !env.data)) {
      throw new Error(`agent_id ${opts.agentId} 不存在`);
    }
    if (env.code !== 0) throw new Error(`agent/get 失败 code=${env.code} msg=${env.message ?? ''}`);
    const agent = env.data!;
    if (agent.team_id !== teamId) throw new Error(`agent ${opts.agentId} 不属于 team ${teamId}`);
    if (agent.owner_user_id !== userId) {
      throw new Error(
        `agent ${opts.agentId} 的 owner(${agent.owner_user_id}) 与当前 userKey 反查用户(${userId}) 不一致`,
      );
    }
    return { agentId: opts.agentId!, ownerUserId: userId };
  }
  if (opts.agentName) {
    const env = await client.post<{ items?: AgentRaw[] }>('/meta/agent/list', {
      team_id: teamId,
      owner_user_id: userId,
      status: 'active',
    });
    if (env.code !== 0) throw new Error(`agent/list 失败 code=${env.code} msg=${env.message ?? ''}`);
    const found = (env.data?.items ?? []).find((a) => a.name === opts.agentName);
    if (!found) throw new Error(`agent「${opts.agentName}」不存在，请先创建或用 --agent-id`);
    return { agentId: found.agent_id, ownerUserId: userId };
  }
  throw new Error('必须提供 --agent-id 或 --agent-name');
}

interface AgentRaw {
  agent_id: string;
  team_id: string;
  owner_user_id: string;
  name: string;
}

// ── 消息分批 + checkpoint ──
const MAX_MESSAGES_PER_REQUEST = 100;
const MAX_MESSAGE_CHARS = 8192;

interface ImportMessage {
  role: string;
  content: string;
  /** 原始来源标识，用于去重 */
  sourceKey?: string;
  /** 消息时间戳（毫秒）。可选，缺失时由后端按导入顺序兜底。 */
  ts?: number;
  /** 该 assistant 消息是否含 tool_use/tool_calls（中间态，非 final answer）。用于对齐 proxy 的 isFinalAnswer 切分。 */
  hasToolUse?: boolean;
  /** skill 链路结构化字段：core /v3/skill/conversation/add 要求 tool_call/tool_result 必须带 tool_call_id（配对锚点）。 */
  tool_call_id?: string;
  tool_name?: string;
  /** 来源记录序号，用于 memory 链路还原成"每条记录一条扁平消息"的旧行为。 */
  recIdx?: number;
  /** memory 链路用的对话流角色（工具片段并入其所在记录的角色）。 */
  memRole?: string;
}

/** 把超长内容按 code unit 切片，避开 UTF-16 代理对边界（借鉴 TDAI proxy 的 chunkConversationMessages）。 */
function splitLongContent(content: string): string[] {
  if (content.length <= MAX_MESSAGE_CHARS) return [content];
  const parts: string[] = [];
  let start = 0;
  while (start < content.length) {
    let end = Math.min(start + MAX_MESSAGE_CHARS, content.length);
    if (end < content.length && isHighSurrogate(content.charCodeAt(end - 1)) && isLowSurrogate(content.charCodeAt(end))) {
      end -= 1;
    }
    parts.push(content.slice(start, end));
    start = end;
  }
  return parts;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xD800 && code <= 0xDBFF;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xDC00 && code <= 0xDFFF;
}

/** 合并同 sourceKey 的消息，超长切片，按 100 条/批拆分。返回批次列表。 */
function batchMessages(messages: ImportMessage[]): ImportMessage[][] {
  const valid = messages.filter((m) => m.role && m.content.trim());
  const flat: ImportMessage[] = [];
  for (const m of valid) {
    for (const piece of splitLongContent(m.content)) {
      flat.push({
        role: m.role,
        content: piece,
        sourceKey: m.sourceKey,
        ts: m.ts,
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.tool_name ? { tool_name: m.tool_name } : {}),
      });
    }
  }
  const batches: ImportMessage[][] = [];
  for (let i = 0; i < flat.length; i += MAX_MESSAGES_PER_REQUEST) {
    batches.push(flat.slice(i, i + MAX_MESSAGES_PER_REQUEST));
  }
  return batches;
}

interface Checkpoint {
  done: string[];
}

function loadCheckpoint(path: string): Checkpoint {
  if (!existsSync(path)) return { done: [] };
  try {
    const obj = JSON.parse(readFileSync(path, 'utf-8'));
    if (Array.isArray(obj?.done)) return { done: obj.done };
  } catch {
    // 损坏的 checkpoint 视为空，不静默忽略——告警后继续
  }
  return { done: [] };
}

function isDone(cp: Checkpoint, sourceKey: string): boolean {
  return cp.done.includes(sourceKey);
}

/** checkpoint 去重 key：按 agent 隔离，避免换 agent 后误跳过。 */
function scopedCheckpointKey(agentId: string, sourceKey: string): string {
  return `${agentId}::${sourceKey}`;
}

function markDone(cp: Checkpoint, sourceKey: string): void {
  if (!cp.done.includes(sourceKey)) cp.done.push(sourceKey);
}

function saveCheckpoint(path: string, cp: Checkpoint): void {
  writeFileSync(path, JSON.stringify(cp, null, 2), { mode: 0o600 });
}

/** 稳定的字符串哈希（非加密，仅作去重 key）。 */
function stableHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

// ── skill / memory 写入与抽取 ──
interface WriteCtx {
  teamId: string;
  agentId: string;
  userId: string;
  /**
   * 导入目标维度。
   * - 'agent'（默认）：skill 绑定到指定 agent（agent_id = ctx.agentId）。
   * - 'team'：直导团队资产池（agent_id = ctx.userId 兜底，对齐 UI
   *   ImportSkillDialog 的 target='team' 语义）。仅 skill 导入支持。
   */
  target: 'agent' | 'team';
}

/** 解析 skill 实际归属的 agent_id：team 池用 userId 兜底，对齐 UI 语义。 */
function resolveSkillAgentId(ctx: WriteCtx): string {
  return ctx.target === 'team' ? ctx.userId : ctx.agentId;
}

/** 从 SKILL.md frontmatter 解析 name（若存在）。 */
function parseFrontmatterName(content: string): string | null {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const nameLine = fm[1].match(/^name:\s*(.+)\s*$/m);
  if (!nameLine) return null;
  return nameLine[1].trim().replace(/^['"]|['"]$/g, '') || null;
}

interface BatchInput {
  msgs: ImportMessage[];
  sourceKey: string;
  /** 真实 session_id：所有批次共用，避免把同一会话拆成多个伪 session。 */
  sessionId: string;
}

/**
 * 把结构化片段还原成 memory 链路所需的"每条记录一条扁平消息"（与改造前行为一致：
 * 工具以 [tool_call] / [tool_result] 文本形式并入对话流，且不出现 tool_call/tool_result 角色，
 * 因为 memory 链路 /chat-memory/import → core /v3/conversation/add 的 schema 仅接受 user/assistant/system）。
 */
function toMemoryMessages(msgs: ImportMessage[]): ImportMessage[] {
  const groups = new Map<number, ImportMessage[]>();
  for (const m of msgs) {
    const key = m.recIdx ?? -1;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }
  const out: ImportMessage[] = [];
  for (const [, group] of groups) {
    const role = group[0].memRole || group[0].role;
    const text = group
      .map((m) => {
        if (m.role === 'tool_call') {
          const one = m.content.replace(/\s+/g, ' ').trim();
          const capped = one.length > 4000 ? `${one.slice(0, 4000)}…` : one;
          return `[tool_call] ${m.tool_name || 'unknown'}(${capped})`;
        }
        if (m.role === 'tool_result') {
          const inner = m.content.replace(/\s+/g, ' ').trim();
          const capped = inner.length > 4000 ? `${inner.slice(0, 4000)}…` : inner;
          return `[tool_result${m.tool_name ? `:${m.tool_name}` : ''}] ${capped}`;
        }
        return m.content;
      })
      .filter(Boolean)
      .join('\n');
    if (text.trim()) {
      out.push({
        role,
        content: text,
        sourceKey: inputSourceKey(msgs),
        ...(group[0].ts !== undefined ? { ts: group[0].ts } : {}),
      });
    }
  }
  return out;
}

// 仅用于 toMemoryMessages 回填 sourceKey（memory 链路 body 不依赖它，但保持结构一致）
function inputSourceKey(msgs: ImportMessage[]): string | undefined {
  return msgs[0]?.sourceKey;
}

/**
 * 上传整段会话到 /chat-memory/import（按 100 条/批拆分）。
 * 面板侧转 core /v3/conversation/add → 落 L0 + 异步触发 L1 memory 抽取。
 * 这是 memory 抽取的唯一入口（与 skill 链路相互独立）。
 */
async function uploadBatches(client: PanelClient, ctx: WriteCtx, input: BatchInput): Promise<void> {
  const mem = toMemoryMessages(input.msgs);
  const batches = batchMessages(mem);
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const body = {
      team_id: ctx.teamId,
      agent_id: ctx.agentId,
      session_id: input.sessionId,
      messages: batch.map((m) =>
        m.ts !== undefined ? { role: m.role, content: m.content, ts: m.ts } : { role: m.role, content: m.content },
      ),
    };
    const env = await client.post('/chat-memory/import', body);
    if (env.code !== 0) {
      throw new Error(`chat-memory/import 失败 code=${env.code} msg=${env.message ?? ''}`);
    }
  }
}

/**
 * 把归一化后的会话消息按"每轮真人对话"切分成多个 round，严格对齐 proxy 的
 * final-answer 切分规则（handler-glue.ts + normalize-conversation.ts）：
 *   - proxy 用 isFinalAnswer(msg) 判定 final：assistant 且不含 tool_use/tool_calls 才是 final answer；
 *   - 每遇到一个 final answer 即收尾为一轮，本轮 = 从上一个 final answer 之后到本次 final answer
 *     （user 输入 + 中间 tool 循环 + final answer），与 proxy findLastFinalAssistant 的切片语义一致。
 *   - 中间的 tool 态 assistant（hasToolUse）不收尾，留在同一轮内。
 * 仅保留含 assistant（即含 final answer 或工具态 assistant）的 round，避免提交无效增量。
 */
function splitIntoRounds(msgs: ImportMessage[]): ImportMessage[][] {
  const rounds: ImportMessage[][] = [];
  let current: ImportMessage[] = [];
  for (const m of msgs) {
    current.push(m);
    // 仅遇到 final answer（assistant 且无 tool_use）时收尾一轮；中间 tool 态不收尾（与 proxy isFinalAnswer 等价）
    if (m.role === 'assistant' && !m.hasToolUse) {
      rounds.push(current);
      current = [];
    }
  }
  // 末尾不以 final answer 结尾时，把残留作为一轮兜底送出（proxy 实时流不会触发，但离线导入要保证送出去）
  if (current.length > 0) rounds.push(current);
  // 保留含 assistant / 工具态（tool_call/tool_result）的 round；纯 user 噪声轮才丢弃
  return rounds.filter((r) => r.some((m) => m.role === 'assistant' || m.role === 'tool_call' || m.role === 'tool_result'));
}

/**
 * 上传会话（skill 链路）：按 final-answer 切片成多个 round，逐轮增量调用 /skill/conversation/add。
 * 触发 skill 抽取（archive + SkillConversationExtractWorker）。单 round 超批上限时再按 batchMessages 拆分。
 *
 * 与 proxy 实时流对齐：
 *  - 工具消息以结构化 5-role 发送（tool_call/tool_result + tool_call_id 配对锚点），不再压平成文本；
 *  - 导入前先 force-archive 清空该 session 已存在的实时流 buffer，避免与离线全量回放叠加重复
 *    （core 的 conversation-add buffer 不去重）。
 */
async function uploadViaConversationAdd(client: PanelClient, ctx: WriteCtx, input: BatchInput): Promise<void> {
  // Fix 2：导入前先强制归档该 session 已存在的 buffer（best-effort，失败不阻断导入）
  try {
    await client.post('/skill/conversation/force-archive', {
      space_id: client.serviceId,
      user_id: ctx.userId,
      team_id: ctx.teamId,
      agent_id: resolveSkillAgentId(ctx),
      session_id: input.sessionId,
      reason: 'offline import pre-flush',
    });
  } catch (e) {
    console.warn(`[warn] force-archive 前置失败（忽略，继续导入）: ${(e as Error).message}`);
  }

  const rounds = splitIntoRounds(input.msgs);
  if (rounds.length === 0) return;
  for (let r = 0; r < rounds.length; r++) {
    const subBatches = batchMessages(rounds[r]);
    for (const batch of subBatches) {
      const body = {
        space_id: client.serviceId,
        user_id: ctx.userId,
        team_id: ctx.teamId,
        agent_id: resolveSkillAgentId(ctx),
        session_id: input.sessionId,
        messages: batch.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.ts !== undefined ? { ts: m.ts } : {}),
          ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
          ...(m.tool_name ? { tool_name: m.tool_name } : {}),
        })),
      };
      const env = await client.post('/skill/conversation/add', body);
      if (env.code !== 0) {
        throw new Error(`skill/conversation/add 失败 code=${env.code} msg=${env.message ?? ''}`);
      }
    }
  }
}



/** Gateway `skill/create` JSON body 上限 1 MiB。 */
export const GATEWAY_MAX_BODY_BYTES = 1024 * 1024;

export type OversizedSkill = { name: string; bytes: number };
export type UploadSkillResult = 'created' | 'skipped' | { oversized: OversizedSkill };

function skillCreateBodyBytes(body: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(body), 'utf8');
}

export function formatSkillBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)}MB`;
  return `${Math.max(1, Math.ceil(n / 1024))}KB`;
}

function buildSkillCreateBody(ctx: WriteCtx, skill: ScannedSkill): { name: string; body: Record<string, unknown> } {
  const name = parseFrontmatterName(skill.content) || skill.name;
  const body: Record<string, unknown> = {
    name,
    content: skill.content,
    team_id: ctx.teamId,
    agent_id: resolveSkillAgentId(ctx),
  };
  if (skill.resources.length > 0) {
    body.resources = skill.resources.map((r) => ({
      path: r.path,
      content: r.content,
      encoding: 'utf-8',
    }));
  }
  return { name, body };
}

/** 估算 `skill/create` JSON 体积；超过上限的整条 skill 应跳过。 */
export function measureSkillCreate(ctx: WriteCtx, skill: ScannedSkill): OversizedSkill {
  const { name, body } = buildSkillCreateBody(ctx, skill);
  return { name, bytes: skillCreateBodyBytes(body) };
}

/** 创建 skill（含 resources）。同名同 owner 报 42201 → 幂等跳过。超过 1MB 整条跳过、不请求。 */
export async function uploadSkill(
  client: PanelClient,
  ctx: WriteCtx,
  skill: ScannedSkill,
): Promise<UploadSkillResult> {
  const { name: skillName, body } = buildSkillCreateBody(ctx, skill);
  const bytes = skillCreateBodyBytes(body);
  if (bytes > GATEWAY_MAX_BODY_BYTES) {
    return { oversized: { name: skillName, bytes } };
  }
  const env = await client.post('/skill/create', body);
  if (env.code === 0) return 'created';
  if (env.code === 42201) return 'skipped'; // NAME_DUPLICATE
  throw new Error(`skill/create 失败 name=${skillName} code=${env.code} msg=${env.message ?? ''}`);
}

interface SessionInput {
  session: ScannedSession;
  /** session 导入时的提取范围：memory=仅落库，skill=仅抽取技能，both=都做。 */
  extract: 'memory' | 'skill' | 'both';
}

/**
 * 导入 session：双链路对齐 proxy 实时流。
 *  1) /chat-memory/import（整段）→ 落 L0 + 异步 L1 memory 抽取
 *  2) /skill/conversation/add（按 final-answer 切片增量）→ skill 抽取
 * memory 与 skill 是 core 里相互独立的两条抽取链路，故都跑（除非 extract 指定只跑其一）。
 *
 * 关于 tool 消息的处理（两条链路差异见下）：
 *  - skill 链路（uploadViaConversationAdd）：下游 core /v3/skill/conversation/add 接受
 *    5-role，tool_call/tool_result 必须带 tool_call_id 配对锚点（缺失 → 40001）。故结构化透传。
 *  - memory 链路（uploadBatches → toMemoryMessages）：下游 core /v3/conversation/add 的 schema
 *    仅接受 user/assistant/system，无 tool 角色。故 toMemoryMessages 将 tool_call/tool_result
 *    还原为文本（[tool_call] name(...) / [tool_result:name] ...）并入对话流，记忆系统关心的是
 *    工具调用的"内容"而非结构化锚点。
 *  因此 uploadSession 不可按 user/assistant 过滤：必须原样保留 tool 角色消息，再由两条链路
 *  各自处理（一个结构化、一个压平）。否则 skill 链路的 tool_call_id 透传会被架空、memory 链路的
 *  工具内容也会整体丢失。
 */
export async function uploadSession(client: PanelClient, ctx: WriteCtx, input: SessionInput): Promise<void> {
  const { session } = input;
  // 不要在此处按 user/assistant 过滤：session.messages 来自 parseJsonlLines /
  // normalizeResponsesJson，已含 tool_call/tool_result 角色（带 tool_call_id 配对锚点）。
  // skill 链路会结构化发送（见 uploadViaConversationAdd），memory 链路会经 toMemoryMessages
  // 压平为文本——二者都依赖工具消息原样保留到这里。故透传全部角色并补齐 tool 字段。
  const raw = session.messages as unknown as ImportMessage[];
  const msgs: ImportMessage[] = raw.map((m) => ({
    role: m.role,
    content: m.content,
    sourceKey: session.sourceKey,
    ts: m.ts,
    hasToolUse: m.hasToolUse,
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.tool_name ? { tool_name: m.tool_name } : {}),
    ...(m.recIdx !== undefined ? { recIdx: m.recIdx } : {}),
    // memRole 是关键：memory 链路 toMemoryMessages 用 group[0].memRole || group[0].role 决定
    // 发给 /chat-memory/import 的角色。若不透传，tool 消息会退回 tool_call/tool_result 原始角色，
    // 而 core /v3/conversation/add 只接受 user/assistant/system → 400。skill 链路用 m.role 原样，
    // 不受影响。
    ...(m.memRole ? { memRole: m.memRole } : {}),
  }));
  if (msgs.length === 0) return;
  const batchInput = { msgs, sourceKey: session.sourceKey, sessionId: session.sessionId };
  // 1) memory 链路：整段导入触发 L1 抽取（extract !== 'skill' 时跑）
  if (input.extract !== 'skill') {
    await uploadBatches(client, ctx, batchInput);
  }
  // 2) skill 链路：按 final-answer 切片增量触发 skill 抽取（extract !== 'memory' 时跑）
  if (input.extract !== 'memory') {
    await uploadViaConversationAdd(client, ctx, batchInput);
  }
}

// ── CLI 解析与主流程 ──
interface CliOpts {
  command: 'import';
  agentId?: string;
  teamId?: string;
  teamName?: string;
  agentName?: string;
  target: 'agent' | 'team';
  sessions?: string;

  force: boolean;
  userKey?: string;
  envFile?: string;
  stateFile: string;
  interactive: boolean;
  yes: boolean;
  /** session 导入时的提取范围：memory=仅落库，skill=仅抽取技能，both=都做（默认）。 */
  extract: 'memory' | 'skill' | 'both';
  /** 指定扫描哪个 agent/ide；auto 则按当前 workspace/./ 识别。 */
  source: string;
  workspace?: string;
}

function parseCli(argv: string[]): CliOpts {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'agent-id': { type: 'string' },
      'team-id': { type: 'string' },
      'team-name': { type: 'string' },
      'agent-name': { type: 'string' },
      sessions: { type: 'string' },

      target: { type: 'string', default: 'agent' },
      force: { type: 'boolean', default: false },
      'user-key': { type: 'string' },
      'env-file': { type: 'string' },
      'state-file': { type: 'string', default: '.asset-import-state.json' },
      workspace: { type: 'string' },
      interactive: { type: 'string' },
      y: { type: 'boolean' },
      yes: { type: 'boolean' },
      extract: { type: 'string', default: 'both' },
      source: { type: 'string', default: 'auto' },
    },
  });
  const command: CliOpts['command'] = 'import';

  const target = values.target === 'team' ? 'team' : 'agent';
  const yes = values.y === true || values.yes === true;
  return {
    command,
    agentId: values['agent-id'],
    teamId: values['team-id'],
    teamName: values['team-name'],
    agentName: values['agent-name'],
    target,
    sessions: values.sessions,

    force: values.force === true,
    userKey: values['user-key'],
    envFile: values['env-file'],
    stateFile: values['state-file'] as string,
    interactive: values.interactive !== 'false' && !yes,
    yes,
    extract:
      values.extract === 'memory' || values.extract === 'skill'
        ? (values.extract as 'memory' | 'skill')
        : 'both',
    source: (values.source as string) || 'auto',
    workspace: values.workspace as string | undefined,
  };
}

async function question(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

/**
 * 交互式选择要导入的项：先列举，再让用户在「全导入 / 不导入 / 部分导入」中选。
 * - interactive=false（--yes / CI）：直接返回全部，等价于全量导入。
 * - 非 TTY（管道输入）：无法交互，安全跳过（返回空）。
 * - 部分导入：输入多个 id（逗号或空格分隔），按 id 过滤。
 *
 * @param getId     取出用于部分筛选的 id（skill 用 name，session 用 sessionId）
 * @param getLabel  列举时的展示文案
 */
/** 从 SKILL.md 内容提取描述（优先 frontmatter 的 description，否则取首段正文）。 */
function skillDescription(content: string): string {
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fm) {
    const m = fm[1].match(/^\s*description\s*:\s*(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  for (const ln of content.split('\n')) {
    const t = ln.trim();
    if (!t || t.startsWith('#') || t.startsWith('---') || t.startsWith('>')) continue;
    return t.slice(0, 120);
  }
  return '';
}

async function selectItems<T>(
  label: string,
  items: T[],
  getId: (item: T) => string,
  getLabel: (item: T) => string,
  interactive: boolean,
  getDetail?: (item: T) => string[],
): Promise<T[]> {
  if (items.length === 0) return [];
  // 非交互（--yes / CI）：默认全量导入
  if (!interactive) return items;
  // 非 TTY（管道输入）无法交互：安全跳过
  if (!process.stdin.isTTY) {
    console.log(`[notice] 非交互终端，跳过: ${label}`);
    return [];
  }
  // 先列举
  console.log(`\n[列举] ${label}（共 ${items.length} 个）:`);
  items.forEach((it, i) => {
    console.log(`  ${String(i + 1).padStart(3)}. [${getId(it)}] ${getLabel(it)}`);
    if (getDetail) for (const d of getDetail(it)) console.log(`       ${d}`);
  });
  const choice = (await question(`请选择导入方式: 1=全导入 2=不导入 3=部分导入 ? `)).trim();
  if (choice === '2') {
    console.log(`[跳过] ${label}`);
    return [];
  }
  if (choice === '3') {
    const raw = (await question('输入要导入的编号/id（逗号/空格分隔，可多个）: ')).trim();
    const wanted = new Set(raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean));
    if (wanted.size === 0) {
      console.log(`[跳过] ${label}（未输入有效编号/id）`);
      return [];
    }
    // 编号（1-based 序号）或 id（名称）均可匹配
    const picked = items.filter((it, i) => wanted.has(getId(it)) || wanted.has(String(i + 1)));
    const missed = [...wanted].filter(
      (id) => !items.some((it, i) => id === getId(it) || id === String(i + 1)),
    );
    if (missed.length) console.warn(`[warn] 以下编号/id 未匹配到: ${missed.join(', ')}`);
    console.log(`[部分导入] ${label}: 选中 ${picked.length}/${items.length}`);
    return picked;
  }
  // 1 或默认：全导入
  return items;
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv.slice(2));
  KIND = resolveSource(opts.source, opts.workspace);
  if (opts.envFile) loadEnvFile(opts.envFile);
  if (opts.userKey) process.env.TDAI_USER_KEY = opts.userKey;

  const cfg = await loadConfigFromEnv(opts.interactive);
  const client = new PanelClient(cfg);
  // 单文件专属源：直接锁定为自身 KIND
  const kind: string = KIND;

  // 单一 userKey：反查 user_id，owner 对齐
  const userId = await resolveUserId(client, cfg.userKey);
  const teamId = await resolveTeam(client, userId, { teamId: opts.teamId, teamName: opts.teamName });
  const agent = await resolveAgent(client, {
    userId,
    teamId,
    agentId: opts.agentId,
    agentName: opts.agentName,
  });
  const ctx: WriteCtx = { teamId, agentId: agent.agentId, userId, target: opts.target };

  const cp: Checkpoint = loadCheckpoint(opts.stateFile);
  const ck = (sourceKey: string) => scopedCheckpointKey(agent.agentId, sourceKey);
  const results = {
    created: 0,
    skipped: 0,
    imported: 0,
    failed: 0,
    oversized: [] as OversizedSkill[],
    errors: [] as string[],
  };
  const scanOpts = opts.workspace ? { workspace: opts.workspace } : undefined;
  const workspaceLabel = opts.workspace ? ` workspace=${opts.workspace}` : '';

  // ── 阶段一：选择要导入的 skill（先列举，再全导入/不导入/部分导入）──
  const skills = await selectItems(
    `导入 skill 到 agent ${agent.agentId}`,
    scanSkills(scanOpts),
    (s) => s.name,
    (s) => s.name,
    opts.interactive,
    (s) => [
      `描述: ${skillDescription(s.content)}`,
      `来源: ${s.sourceKey.replace(`skill:${KIND}:`, '')}`,
      `关联脚本: ${s.resources.length}`,
    ],
  );

  if (skills.length > 0) {
    for (const s of skills) {
      if (!opts.force && isDone(cp, ck(s.sourceKey))) {
        results.skipped++;
        continue;
      }
      try {
        const r = await uploadSkill(client, ctx, s);
        if (typeof r === 'object' && r.oversized) {
          results.skipped++;
          results.oversized.push(r.oversized);
          continue;
        }
        if (r === 'created') results.created++;
        else results.skipped++;
        markDone(cp, ck(s.sourceKey));
      } catch (e) {
        results.failed++;
        results.errors.push(`skill ${s.name}: ${(e as Error).message}`);
      }
    }
    saveCheckpoint(opts.stateFile, cp);
  }

  // ── 阶段二：选择要导入的 session（先列举，再全导入/不导入/部分导入）──
  // `--sessions` 有两种语义：
  //   1) 已存在的目录 → 通用覆盖扫描入口
  //   2) 逗号分隔的 session id → 在默认扫描结果上按 id 筛选
  const sessionsDir =
    opts.sessions && existsSync(opts.sessions) && statSync(opts.sessions).isDirectory()
      ? opts.sessions
      : undefined;
  let sessions = scanSessions(sessionsDir, scanOpts);
  if (opts.sessions && !sessionsDir) {
    const ids = new Set(opts.sessions.split(',').map((s) => s.trim()).filter(Boolean));
    if (ids.size) sessions = sessions.filter((s) => ids.has(s.sessionId));
  }
  console.log(`[探测] kind=${kind}${workspaceLabel} skills=${skills.length} sessions=${sessions.length}`);
  sessions = await selectItems(
    `上传 session 到 agent ${agent.agentId}`,
    sessions,
    (s) => s.sessionId,
    (s) => s.sessionId,
    opts.interactive,
    (s) => {
      let timeRange = '未知';
      try {
        const meta = extractSessionMeta(readFileSync(s.origin, 'utf-8'));
        if (meta.timeRange) timeRange = meta.timeRange;
      } catch {
        /* 读取失败则保持未知 */
      }
      const isWarmup = (c: string) => c.trim().toLowerCase() === 'warmup';
      const isBlank = (c: string) => !c || !c.trim();
      const firstUser = s.messages.find(
        (m) => m.role === 'user' && !isWarmup(m.content ?? '') && !isBlank(m.content ?? ''),
      );
      const summary = firstUser
        ? firstUser.content.replace(/\s+/g, ' ').trim().slice(0, 120)
        : (() => {
            const fb = s.messages.find((m) => !isWarmup(m.content ?? '') && !isBlank(m.content ?? ''));
            return fb ? fb.content.replace(/\s+/g, ' ').trim().slice(0, 120) : '（无实际内容）';
          })();
      return [`路径: ${s.origin}`, `时间范围: ${timeRange}`, `摘要: ${summary}`];
    },
  );

  if (sessions.length > 0) {
    for (const s of sessions) {
      if (!opts.force && isDone(cp, ck(s.sourceKey))) continue;
      try {
        await uploadSession(client, ctx, { session: s, extract: opts.extract });
        results.imported++;
        markDone(cp, ck(s.sourceKey));
      } catch (e) {
        results.failed++;
        results.errors.push(`session ${s.sessionId}: ${(e as Error).message}`);
      }
    }
    saveCheckpoint(opts.stateFile, cp);
  }

  if (results.oversized.length > 0) {
    console.log(`\n[跳过] ${results.oversized.length} 个 skill 超过 gateway 1MB 上限，未导入:`);
    for (const s of results.oversized) {
      console.log(`- ${s.name} (${formatSkillBytes(s.bytes)})`);
    }
  }
  console.log('\n=== 结果 ===');
  console.log(
    JSON.stringify(
      {
        ...results,
        oversized: results.oversized.map((s) => ({ name: s.name, bytes: s.bytes, size: formatSkillBytes(s.bytes) })),
      },
      null,
      2,
    ),
  );
  if (results.failed > 0) process.exitCode = 1;
}

/** 直接运行本文件（tsx agents/asset-import.ts --source <ide>）时执行主流程。 */
function runIfMain(metaUrl: string): void {
  const self = fileURLToPath(metaUrl);
  const entry = process.argv[1] ? resolve(process.argv[1]) : '';
  if (entry !== self) return;
  main().catch((e) => {
    console.error(`错误: ${(e as Error).message}`);
    process.exit(1);
  });
}



// ── 各 IDE 适配器 ──
interface IdeAdapter {
  kind: string;
  scanSkills(opts?: ScanOptions): ScannedSkill[];
  scanSessions(sessionsDir?: string, opts?: ScanOptions): ScannedSession[];
  scanSessionsOverride(kind: AgentKind, sessionsDir: string): ScannedSession[];
  detect(): boolean;
}

function make_openclawAdapter(): IdeAdapter {
const KIND = 'openclaw' as const;

function openclawHome(): string {
  const env = process.env.OPENCLAW_STATE_DIR?.trim();
  return env ? resolve(env) : join(home(), '.openclaw');
}

function openclawConfig(): Record<string, unknown> | null {
  return readJsonObject(join(openclawHome(), 'openclaw.json'));
}

function looksLikeOpenClawWorkspace(dir: string): boolean {
  return ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'MEMORY.md', 'skills'].some((n) => existsSync(join(dir, n)));
}

/** 从 openclaw.json 收集 agent workspace 目录（含嵌套 workspace/ 子目录）。 */
function openclawAgentWorkspaces(opts?: ScanOptions): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw?: string): void => {
    if (!raw) return;
    const key = resolve(raw);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(key);
    const nested = join(key, 'workspace');
    const nestedKey = resolve(nested);
    if (!seen.has(nestedKey) && existsSync(nested) && statSync(nested).isDirectory() && looksLikeOpenClawWorkspace(nested)) {
      seen.add(nestedKey);
      out.push(nestedKey);
    }
  };
  add(process.env.OPENCLAW_WORKSPACE_DIR);
  // 默认 workspace 目录
  add(join(openclawHome(), 'workspace'));
  const agents = openclawConfig()?.agents;
  if (agents && typeof agents === 'object' && !Array.isArray(agents)) {
    const rec = agents as Record<string, unknown>;
    const defaults = rec.defaults && typeof rec.defaults === 'object' ? (rec.defaults as Record<string, unknown>) : undefined;
    if (defaults && typeof defaults.workspace === 'string') add(defaults.workspace);
    const list = Array.isArray(rec.list) ? rec.list : [];
    for (const item of list) {
      if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).workspace === 'string') {
        add((item as Record<string, unknown>).workspace as string);
      }
    }
  }
  return out;
}

function openclawBundledSkillsDir(): string {
  return join(home(), 'npm-global', 'lib', 'node_modules', 'openclaw', 'skills');
}

/** 一层 skill 根：<name>/SKILL.md + scripts/references/assets/agents。 */
function collectOpenClawSkillsFromRoot(root: string): ScannedSkill[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const out: ScannedSkill[] = [];
  for (const entry of readdirSync(root)) {
    if (entry.startsWith('.')) continue;
    const skillDir = join(root, entry);
    let st;
    try {
      st = statSync(skillDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const text = readIfExists(join(skillDir, 'SKILL.md'));
    if (text == null) continue;
    const resources: { path: string; content: string }[] = [];
    for (const sub of ['scripts', 'references', 'assets', 'agents']) collectSubfiles(skillDir, sub, resources);
    out.push({ name: skillNameFromContent(entry, text), content: text, resources, sourceKey: `skill:${KIND}:${skillDir}` });
  }
  return out;
}

/**
 * OpenClaw skill 两层（同名用户自定义覆盖系统内置）：
 *  1 用户自定义  ~/.agents/skills
 *  2 系统内置    ~/npm-global/lib/node_modules/openclaw/skills
 */
function collectOpenClawSkills(): ScannedSkill[] {
  const ranked = [join(home(), '.agents', 'skills'), openclawBundledSkillsDir()];
  const out: ScannedSkill[] = [];
  const seen = new Set<string>();
  const seenRoots = new Set<string>();
  for (const root of ranked) {
    const key = resolve(root);
    if (seenRoots.has(key)) continue;
    seenRoots.add(key);
    for (const skill of collectOpenClawSkillsFromRoot(root)) {
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      out.push(skill);
    }
  }
  return out;
}

function collectOpenClawMemoryFiles(opts?: ScanOptions): string[] {
  const files: string[] = [];
  const daily = /^\d{4}-\d{2}-\d{2}\.md$/;
  for (const w of openclawAgentWorkspaces(opts)) {
    for (const f of ['MEMORY.md', 'DREAMS.md']) {
      const p = join(w, f);
      if (readIfExists(p)?.trim()) files.push(p);
    }
    const memDir = join(w, 'memory');
    if (!existsSync(memDir) || !statSync(memDir).isDirectory()) continue;
    for (const name of readdirSync(memDir)) {
      if (!daily.test(name)) continue;
      const p = join(memDir, name);
      if (readIfExists(p)?.trim()) files.push(p);
    }
  }
  return files;
}

function detect(): boolean {
  return existsSync(join(home(), '.openclaw'));
}

function scanSkills(_opts?: ScanOptions): ScannedSkill[] {
  return collectOpenClawSkills();
}

function scanMemoryFiles(opts?: ScanOptions): ScannedMemoryFile[] {
  const files: string[] = [...collectOpenClawMemoryFiles(opts)];
  return memoryFilesFromPaths(KIND, files);
}

function scanSessions(sessionsDir?: string, _opts?: ScanOptions): ScannedSession[] {
  if (sessionsDir) return scanSessionsOverride(KIND, sessionsDir);
  const out: ScannedSession[] = [];
  const sessionsRoot = join(home(), '.openclaw', 'agents');
  if (!existsSync(sessionsRoot)) return out;
  for (const agentId of readdirSync(sessionsRoot)) {
    const dir = join(sessionsRoot, agentId);
    if (!statSync(dir).isDirectory()) continue;
    const sessionsDirPath = join(dir, 'sessions');
    if (!existsSync(sessionsDirPath)) continue;
    for (const f of listJsonlRecursive(sessionsDirPath)) {
      if (f.endsWith('.lock') || f.endsWith('.trajectory.jsonl')) continue;
      const msgs = parseJsonlLines(readFileSync(f, 'utf-8'));
      if (msgs.length) out.push({ sessionId: `${agentId}/${basename(f, '.jsonl')}`, messages: msgs, sourceKey: `session:${KIND}:${f}`, origin: f });
    }
  }
  return out;
}


function scanSessionsOverride(kind: AgentKind, sessionsDir: string): ScannedSession[] {
  const out: ScannedSession[] = [];
  if (!existsSync(sessionsDir)) return out;
  const st = statSync(sessionsDir);
  const jsonlFiles = st.isDirectory()
    ? listJsonlRecursive(sessionsDir)
    : sessionsDir.endsWith('.jsonl')
      ? [sessionsDir]
      : [];
  const jsonFiles = st.isDirectory()
    ? readdirSync(sessionsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => join(sessionsDir, f))
    : sessionsDir.endsWith('.json')
      ? [sessionsDir]
      : [];
  for (const full of jsonlFiles) {
    const text = readFileSync(full, 'utf-8');
    const msgs = parseJsonlLines(text);
    if (!msgs.length) continue;
    out.push({
      sessionId: extractCodexSessionId(full, text),
      messages: msgs,
      sourceKey: `session:${kind}:${full}`,
      origin: full,
    });
  }
  for (const full of jsonFiles) {
    const msgs = normalizeResponsesJson(full);
    if (!msgs.length) continue;
    out.push({
      sessionId: basename(full, '.json'),
      messages: msgs,
      sourceKey: `session:${kind}:${full}`,
      origin: full,
    });
  }
  return out;
}
  return { kind: KIND, scanSkills, scanSessions, scanSessionsOverride, detect };
}
function make_codebuddyAdapter(): IdeAdapter {
const KIND = 'codebuddy' as const;

function detect(): boolean {
  // 仅看 home / 环境变量；cwd 判定统一交给 resolveSource 的 detectByCwdMarker
  return Boolean(process.env.CODEBUDDY_HOME) || existsSync(join(home(), '.codebuddy'));
}

function scanSkills(opts?: ScanOptions): ScannedSkill[] {
  const cwd = projectCwd(opts);
  const h = home();
  return collectSkillDirs(KIND, [join(h, '.codebuddy', 'skills'), join(cwd, '.codebuddy', 'skills')]);
}

function scanMemoryFiles(opts?: ScanOptions): ScannedMemoryFile[] {
  const cwd = projectCwd(opts);
  const h = home();
  const files: string[] = [];
  const push = (p: string) => files.push(p);
  push(join(h, '.codebuddy', 'CODEBUDDY.md'));
  if (existsSync(join(cwd, 'CODEBUDDY.md'))) push(join(cwd, 'CODEBUDDY.md'));
  // codebuddy 记忆目录：memories/（兼容拼写错误 memery/），展开其下所有 .md
  for (const base of [join(h, '.codebuddy'), join(cwd, '.codebuddy')]) {
    for (const dirName of ['memories', 'memery']) {
      const mem = join(base, dirName);
      if (existsSync(mem)) files.push(...listMdRecursive(mem));
    }
  }
  return memoryFilesFromPaths(KIND, files);
}

function scanSessions(sessionsDir?: string, _opts?: ScanOptions): ScannedSession[] {
  if (sessionsDir) return scanSessionsOverride(KIND, sessionsDir);
  const out: ScannedSession[] = [];
  // 真实会话位置：~/.codebuddy/projects/<project>/*.jsonl
  const root = join(home(), '.codebuddy', 'projects');
  if (existsSync(root)) {
    for (const proj of readdirSync(root)) {
      const dir = join(root, proj);
      if (!statSync(dir).isDirectory()) continue;
      for (const f of listJsonlRecursive(dir)) {
        const msgs = parseJsonlLines(readFileSync(f, 'utf-8'));
        if (msgs.length) out.push({ sessionId: `${proj}/${basename(f, '.jsonl')}`, messages: msgs, sourceKey: `session:${KIND}:${f}`, origin: f });
      }
    }
  }
  // 回退：旧版 ~/.codebuddy/sessions/*.jsonl
  const legacy = join(home(), '.codebuddy', 'sessions');
  if (existsSync(legacy)) {
    for (const f of listJsonlRecursive(legacy)) {
      const msgs = parseJsonlLines(readFileSync(f, 'utf-8'));
      if (msgs.length) out.push({ sessionId: basename(f, '.jsonl'), messages: msgs, sourceKey: `session:${KIND}:${f}`, origin: f });
    }
  }
  return out;
}


function scanSessionsOverride(kind: AgentKind, sessionsDir: string): ScannedSession[] {
  const out: ScannedSession[] = [];
  if (!existsSync(sessionsDir)) return out;
  const st = statSync(sessionsDir);
  const jsonlFiles = st.isDirectory()
    ? listJsonlRecursive(sessionsDir)
    : sessionsDir.endsWith('.jsonl')
      ? [sessionsDir]
      : [];
  const jsonFiles = st.isDirectory()
    ? readdirSync(sessionsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => join(sessionsDir, f))
    : sessionsDir.endsWith('.json')
      ? [sessionsDir]
      : [];
  for (const full of jsonlFiles) {
    const text = readFileSync(full, 'utf-8');
    const msgs = parseJsonlLines(text);
    if (!msgs.length) continue;
    out.push({
      sessionId: extractCodexSessionId(full, text),
      messages: msgs,
      sourceKey: `session:${kind}:${full}`,
      origin: full,
    });
  }
  for (const full of jsonFiles) {
    const msgs = normalizeResponsesJson(full);
    if (!msgs.length) continue;
    out.push({
      sessionId: basename(full, '.json'),
      messages: msgs,
      sourceKey: `session:${kind}:${full}`,
      origin: full,
    });
  }
  return out;
}
  return { kind: KIND, scanSkills, scanSessions, scanSessionsOverride, detect };
}
function make_codexAdapter(): IdeAdapter {
const KIND = 'codex' as const;

function detect(): boolean {
  return Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_HOME || process.env.CODEX_HOME_DIR);
}

function scanSkills(opts?: ScanOptions): ScannedSkill[] {
  const cwd = projectCwd(opts);
  const h = home();
  const roots: string[] = [];
  // codex 官方用户级 skill：~/.agents/skills
  roots.push(join(h, '.agents', 'skills'));
  roots.push('/etc/codex/skills');
  // 仓库级 .agents/skills：从 git 根到 cwd 逐层（覆写优先于基础）
  for (const d of dirsFromRepoRootToCwd(cwd)) {
    roots.push(join(d, '.agents', 'skills'));
  }
  return collectSkillDirs(KIND, roots);
}

function codexHome(): string {
  const env = process.env.CODEX_HOME?.trim();
  return env ? resolve(env) : join(home(), '.codex');
}

function scanMemoryFiles(opts?: ScanOptions): ScannedMemoryFile[] {
  const cwd = projectCwd(opts);
  const co = codexHome();
  const files: string[] = [];
  const push = (p: string) => files.push(p);
  const globalOverride = join(co, 'AGENTS.override.md');
  if (readIfExists(globalOverride)?.trim()) push(globalOverride);
  else push(join(co, 'AGENTS.md'));
  const memRoot = join(co, 'memories');
  if (existsSync(memRoot)) files.push(...listMdRecursive(memRoot));
  for (const d of dirsFromRepoRootToCwd(cwd)) {
    const localOverride = join(d, 'AGENTS.override.md');
    if (readIfExists(localOverride)?.trim()) push(localOverride);
    else push(join(d, 'AGENTS.md'));
  }
  return memoryFilesFromPaths(KIND, files);
}

function scanSessions(sessionsDir?: string, _opts?: ScanOptions): ScannedSession[] {
  if (sessionsDir) return scanSessionsOverride(KIND, sessionsDir);
  const out: ScannedSession[] = [];
  const sessionsRoot = join(codexHome(), 'sessions');
  if (!existsSync(sessionsRoot)) return out;
  for (const full of listJsonlRecursive(sessionsRoot)) {
    const text = readFileSync(full, 'utf-8');
    const msgs = parseJsonlLines(text);
    if (!msgs.length) continue;
    out.push({ sessionId: extractCodexSessionId(full, text), messages: msgs, sourceKey: `session:${KIND}:${full}`, origin: full });
  }
  return out;
}


function scanSessionsOverride(kind: AgentKind, sessionsDir: string): ScannedSession[] {
  const out: ScannedSession[] = [];
  if (!existsSync(sessionsDir)) return out;
  const st = statSync(sessionsDir);
  const jsonlFiles = st.isDirectory()
    ? listJsonlRecursive(sessionsDir)
    : sessionsDir.endsWith('.jsonl')
      ? [sessionsDir]
      : [];
  const jsonFiles = st.isDirectory()
    ? readdirSync(sessionsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => join(sessionsDir, f))
    : sessionsDir.endsWith('.json')
      ? [sessionsDir]
      : [];
  for (const full of jsonlFiles) {
    const text = readFileSync(full, 'utf-8');
    const msgs = parseJsonlLines(text);
    if (!msgs.length) continue;
    out.push({
      sessionId: extractCodexSessionId(full, text),
      messages: msgs,
      sourceKey: `session:${kind}:${full}`,
      origin: full,
    });
  }
  for (const full of jsonFiles) {
    const msgs = normalizeResponsesJson(full);
    if (!msgs.length) continue;
    out.push({
      sessionId: basename(full, '.json'),
      messages: msgs,
      sourceKey: `session:${kind}:${full}`,
      origin: full,
    });
  }
  return out;
}
  return { kind: KIND, scanSkills, scanSessions, scanSessionsOverride, detect };
}
function make_claude_codeAdapter(): IdeAdapter {
const KIND = 'claude-code' as const;

function detect(): boolean {
  return Boolean(process.env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CODE_ENTRY);
}

function scanSkills(opts?: ScanOptions): ScannedSkill[] {
  const cwd = projectCwd(opts);
  const h = home();
  return collectSkillDirs(KIND, [join(h, '.claude', 'skills'), join(cwd, '.claude', 'skills')]);
}

function scanMemoryFiles(opts?: ScanOptions): ScannedMemoryFile[] {
  const cwd = projectCwd(opts);
  const h = home();
  const files: string[] = [];
  const push = (p: string) => files.push(p);
  push(join(h, '.claude', 'CLAUDE.md'));
  push(join(cwd, 'CLAUDE.md'));
  const memDir = join(h, '.claude', 'projects');
  if (existsSync(memDir)) {
    for (const proj of readdirSync(memDir)) {
      files.push(...listMd(join(memDir, proj, 'memory')));
    }
  }
  return memoryFilesFromPaths(KIND, files);
}

function scanSessions(sessionsDir?: string, _opts?: ScanOptions): ScannedSession[] {
  if (sessionsDir) return scanSessionsOverride(KIND, sessionsDir);
  const out: ScannedSession[] = [];
  const root = join(home(), '.claude', 'projects');
  if (!existsSync(root)) return out;
  for (const proj of readdirSync(root)) {
    const pd = join(root, proj);
    if (!statSync(pd).isDirectory()) continue;
    for (const f of readdirSync(pd)) {
      if (!f.endsWith('.jsonl')) continue;
      const full = join(pd, f);
      const msgs = parseJsonlLines(readFileSync(full, 'utf-8'));
      if (msgs.length) {
        out.push({ sessionId: f.replace('.jsonl', ''), messages: msgs, sourceKey: `session:${KIND}:${full}`, origin: full });
      }
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════

function scanSessionsOverride(kind: AgentKind, sessionsDir: string): ScannedSession[] {
  const out: ScannedSession[] = [];
  if (!existsSync(sessionsDir)) return out;
  const st = statSync(sessionsDir);
  const jsonlFiles = st.isDirectory()
    ? listJsonlRecursive(sessionsDir)
    : sessionsDir.endsWith('.jsonl')
      ? [sessionsDir]
      : [];
  const jsonFiles = st.isDirectory()
    ? readdirSync(sessionsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => join(sessionsDir, f))
    : sessionsDir.endsWith('.json')
      ? [sessionsDir]
      : [];
  for (const full of jsonlFiles) {
    const text = readFileSync(full, 'utf-8');
    const msgs = parseJsonlLines(text);
    if (!msgs.length) continue;
    out.push({
      sessionId: extractCodexSessionId(full, text),
      messages: msgs,
      sourceKey: `session:${kind}:${full}`,
      origin: full,
    });
  }
  for (const full of jsonFiles) {
    const msgs = normalizeResponsesJson(full);
    if (!msgs.length) continue;
    out.push({
      sessionId: basename(full, '.json'),
      messages: msgs,
      sourceKey: `session:${kind}:${full}`,
      origin: full,
    });
  }
  return out;
}
  return { kind: KIND, scanSkills, scanSessions, scanSessionsOverride, detect };
}
function make_dshAdapter(): IdeAdapter {
const KIND = 'dsh' as const;

function readZstdUtf8(path: string): string | null {
  try {
    const r = spawnSync('zstd', ['-d', '-c', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0) return r.stdout;
    const fallback = spawnSync('unzstd', ['-c', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (fallback.status === 0) return fallback.stdout;
    return null;
  } catch {
    return null;
  }
}

/** 解析 dsh session（zstd 解压后是事件流 jsonl：每行 type + data）。 */
function parseDshSessionLines(text: string): ScannedSession['messages'] {
  const msgs: ScannedSession['messages'] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      const data = obj.data && typeof obj.data === 'object' ? (obj.data as Record<string, unknown>) : undefined;
      if (obj.type === 'user/message' && data) {
        const role = typeof data.role === 'string' ? data.role : 'user';
        const content = extractText(data.content);
        if (content && !isHarnessNoise(role, content)) msgs.push({ role, content });
        continue;
      }
      if (obj.type === 'assistant/message' && data) {
        const nested = data.message && typeof data.message === 'object' ? (data.message as Record<string, unknown>) : data;
        const role = typeof nested.role === 'string' ? nested.role : 'assistant';
        const content = extractText(nested.content);
        if (content && !isHarnessNoise(role, content)) msgs.push({ role, content });
      }
    } catch {
      // 跳过非 JSON 行
    }
  }
  return msgs;
}

function dshHome(): string {
  const env = process.env.DSH_HOME?.trim();
  return env ? resolve(env) : join(home(), '.dsh');
}
function dshAgentsHome(): string {
  const env = process.env.DSH_AGENTS_HOME?.trim();
  return env ? resolve(env) : join(home(), '.agents');
}
function dshCustomSkillDirs(): string[] {
  const fromEnv = (process.env.DSH_CUSTOM_SKILL_DIRS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return fromEnv.map((p) => resolve(p.replace(/^~(?=\/|$)/, home())));
}

const DSH_INSTRUCTION_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const;
const DSH_LOCAL_INSTRUCTION_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md'] as const;

function sha1Trimmed(text: string): string {
  return createHash('sha1').update(text.trim()).digest('hex');
}

function readYamlStringList(text: string | null, key: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const listRe = new RegExp(`^\\s*${key}\\s*:\\s*\\n(\\s*-\\s*.+(\\n|$))+`, 'm');
  const listMatch = text.match(listRe);
  if (listMatch) {
    for (const m of listMatch[0].matchAll(/\n\s*-\s*(.+)/g)) out.push(m[1].trim().replace(/^['"]|['"]$/g, ''));
    return out;
  }
  const scalarRe = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'm');
  const m = text.match(scalarRe);
  if (m) out.push(m[1].trim().replace(/^['"]|['"]$/g, ''));
  return out;
}

/** DSH skill 根：目录式 name/SKILL.md 或平铺 name.md（一层，不递归）。 */
function collectSkillsFromDshRoot(root: string, skipSystem = false): ScannedSkill[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const out: ScannedSkill[] = [];
  for (const entry of readdirSync(root)) {
    if (entry.startsWith('.') || (skipSystem && entry === '.system')) continue;
    const full = join(root, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const skillMd = join(full, 'SKILL.md');
      const text = readIfExists(skillMd);
      if (text == null) continue;
      const resources: { path: string; content: string }[] = [];
      for (const sub of ['scripts', 'references', 'assets', 'agents']) collectSubfiles(full, sub, resources);
      out.push({ name: skillNameFromContent(entry, text), content: text, resources, sourceKey: `skill:${KIND}:${full}` });
    } else if (st.isFile() && entry.endsWith('.md') && entry !== 'SKILL.md') {
      const text = readIfExists(full);
      if (text == null || !text.trim()) continue;
      const fallback = entry.replace(/\.md$/i, '');
      out.push({ name: skillNameFromContent(fallback, text), content: text, resources: [], sourceKey: `skill:${KIND}:${full}` });
    }
  }
  return out;
}

function collectDshInstructionFilesInDir(dir: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [...DSH_INSTRUCTION_CANDIDATES, ...DSH_LOCAL_INSTRUCTION_CANDIDATES]) {
    const full = join(dir, name);
    const text = readIfExists(full);
    if (text == null || !text.trim()) continue;
    const digest = sha1Trimmed(text);
    if (seen.has(digest)) continue;
    seen.add(digest);
    out.push(full);
  }
  return out;
}

function dshBundledSkillDir(): string | undefined {
  const env = process.env.DSH_BUNDLED_SKILL_DIR?.trim();
  if (env) return resolve(env);
  const fromYaml = readYamlStringList(readIfExists(join(dshHome(), 'settings.yaml')), 'bundledSkillDir');
  if (fromYaml[0]) return resolve(fromYaml[0].replace(/^~(?=\/|$)/, home()));
  return undefined;
}

function detect(): boolean {
  return existsSync(join(dshHome(), 'skills')) || existsSync(join(dshHome(), 'AGENTS.md')) || existsSync(join(dshHome(), 'sessions'));
}

function scanSkills(opts?: ScanOptions): ScannedSkill[] {
  const cwd = projectCwd(opts);
  const projectRoot = gitRootOrCwd(cwd);
  const ranked: { path: string; skipSystem?: boolean }[] = [
    { path: join(projectRoot, '.dsh', 'skills') },
    { path: join(projectRoot, '.agents', 'skills') },
    ...dshCustomSkillDirs().map((path) => ({ path })),
    { path: join(dshHome(), 'skills'), skipSystem: true },
    { path: join(dshAgentsHome(), 'skills') },
  ];
  const bundled = dshBundledSkillDir();
  if (bundled) ranked.push({ path: bundled });
  const out: ScannedSkill[] = [];
  const seen = new Set<string>();
  const seenRoots = new Set<string>();
  for (const r of ranked) {
    const key = resolve(r.path);
    if (seenRoots.has(key)) continue;
    seenRoots.add(key);
    for (const skill of collectSkillsFromDshRoot(r.path, r.skipSystem === true)) {
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      out.push(skill);
    }
  }
  return out;
}

function scanMemoryFiles(opts?: ScanOptions): ScannedMemoryFile[] {
  const cwd = projectCwd(opts);
  const files: string[] = [];
  const globalAgents = join(dshHome(), 'AGENTS.md');
  if (readIfExists(globalAgents)?.trim()) files.push(globalAgents);
  for (const dir of dirsFromRepoRootToCwd(cwd)) {
    files.push(...collectDshInstructionFilesInDir(dir));
  }
  return memoryFilesFromPaths(KIND, files);
}

function scanSessions(sessionsDir?: string, _opts?: ScanOptions): ScannedSession[] {
  if (sessionsDir) return scanSessionsOverride(KIND, sessionsDir);
  const out: ScannedSession[] = [];
  const sessionsRoot = join(dshHome(), 'sessions');
  if (!existsSync(sessionsRoot)) return out;
  for (const full of walkFiles(sessionsRoot, (n) => n === 'session.jsonl.zstd' || n === 'session.jsonl')) {
    const text = full.endsWith('.zstd') ? readZstdUtf8(full) : readFileSync(full, 'utf-8');
    if (!text) continue;
    const msgs = parseDshSessionLines(text);
    if (!msgs.length) continue;
    out.push({ sessionId: basename(dirname(full)), messages: msgs, sourceKey: `session:${KIND}:${full}`, origin: full });
  }
  return out;
}


function scanSessionsOverride(kind: AgentKind, sessionsDir: string): ScannedSession[] {
  const out: ScannedSession[] = [];
  if (!existsSync(sessionsDir)) return out;
  const st = statSync(sessionsDir);
  const jsonlFiles = st.isDirectory()
    ? listJsonlRecursive(sessionsDir)
    : sessionsDir.endsWith('.jsonl')
      ? [sessionsDir]
      : [];
  const jsonFiles = st.isDirectory()
    ? readdirSync(sessionsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => join(sessionsDir, f))
    : sessionsDir.endsWith('.json')
      ? [sessionsDir]
      : [];
  for (const full of jsonlFiles) {
    const text = readFileSync(full, 'utf-8');
    const msgs = parseJsonlLines(text);
    if (!msgs.length) continue;
    out.push({
      sessionId: extractCodexSessionId(full, text),
      messages: msgs,
      sourceKey: `session:${kind}:${full}`,
      origin: full,
    });
  }
  for (const full of jsonFiles) {
    const msgs = normalizeResponsesJson(full);
    if (!msgs.length) continue;
    out.push({
      sessionId: basename(full, '.json'),
      messages: msgs,
      sourceKey: `session:${kind}:${full}`,
      origin: full,
    });
  }
  return out;
}
  return { kind: KIND, scanSkills, scanSessions, scanSessionsOverride, detect };
}
function make_hermesAdapter(): IdeAdapter {
const KIND = 'hermes' as const;

const HERMES_EXCLUDED_SKILL_DIRS = new Set([
  'node_modules', '.git', '.turbo', 'dist', 'build', 'out',
  '.next', '.nuxt', '.svelte-kit', 'coverage', '.cache',
  '.venv', 'venv', '__pycache__', 'target', 'bin', 'obj',
  '.idea', '.vscode', '.DS_Store',
]);
const HERMES_SKILL_SUPPORT_DIRS = new Set(['support', '_support']);
const HERMES_SKILL_RESOURCE_DIRS = new Set(['scripts', 'references', 'assets', 'agents']);

function hermesHome(): string {
  return process.env.HERMES_HOME || join(home(), '.hermes');
}

function walkHermesSkillMd(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  if (HERMES_EXCLUDED_SKILL_DIRS.has(basename(dir))) return;
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (HERMES_EXCLUDED_SKILL_DIRS.has(name)) continue;
      if (name.startsWith('.')) continue;
      walkHermesSkillMd(full, out);
    } else if (name === 'SKILL.md' && !isHermesSupportSkillMd(full)) {
      out.push(full);
    }
  }
}

function isHermesSupportSkillMd(p: string): boolean {
  const parent = basename(dirname(p));
  const grand = basename(dirname(dirname(p)));
  return HERMES_SKILL_SUPPORT_DIRS.has(parent) || HERMES_SKILL_SUPPORT_DIRS.has(grand);
}

/** 在 skill 根内递归找所有 SKILL.md（跳过 support 等），<name>/SKILL.md 归到 <name>。 */
function collectHermesSkillsFromRoot(root: string): ScannedSkill[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const out: ScannedSkill[] = [];
  const seen = new Set<string>();
  for (const entry of readdirSync(root)) {
    if (entry.startsWith('.')) continue;
    const dir = join(root, entry);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const mdPaths: string[] = [];
    walkHermesSkillMd(dir, mdPaths);
    if (mdPaths.length === 0) continue;
    const skillMd = join(dir, 'SKILL.md');
    const text = readIfExists(skillMd) ?? readIfExists(mdPaths[0]);
    if (text == null) continue;
    const name = skillNameFromContent(entry, text);
    if (seen.has(name)) continue;
    seen.add(name);
    const resources: { path: string; content: string }[] = [];
    for (const sub of HERMES_SKILL_RESOURCE_DIRS) collectSubfiles(dir, sub, resources);
    out.push({ name, content: text, resources, sourceKey: `skill:${KIND}:${dir}` });
  }
  return out;
}

function hermesAgentRepo(): string | null {
  const root = process.env.HERMES_AGENT_ROOT?.trim();
  if (root) return resolve(root);
  const candidate = join(hermesHome(), 'hermes-agent');
  return existsSync(candidate) ? candidate : null;
}

function hermesBundledSkillRoots(): string[] {
  const roots: string[] = [];
  const envRoots = [
    process.env.HERMES_BUNDLED_SKILLS?.trim(),
    process.env.HERMES_OPTIONAL_SKILLS?.trim(),
  ].filter(Boolean) as string[];
  for (const e of envRoots) {
    for (const part of e.split(',')) {
      const p = part.trim();
      if (p) roots.push(resolve(p));
    }
  }
  const repo = hermesAgentRepo();
  if (repo) {
    roots.push(join(repo, 'skills'));
    roots.push(join(repo, 'optional-skills'));
  }
  return roots;
}

/** Hermes skill 两层（用户自定义覆盖系统内置）：HOME/skills + 仓库 skills/optional-skills。 */
function collectHermesSkills(): ScannedSkill[] {
  const ranked = [join(hermesHome(), 'skills'), ...hermesBundledSkillRoots()];
  const out: ScannedSkill[] = [];
  const seen = new Set<string>();
  const seenRoots = new Set<string>();
  for (const root of ranked) {
    const key = resolve(root);
    if (seenRoots.has(key)) continue;
    seenRoots.add(key);
    for (const skill of collectHermesSkillsFromRoot(root)) {
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      out.push(skill);
    }
  }
  return out;
}

function detect(): boolean {
  return existsSync(join(home(), '.hermes'));
}

function scanSkills(_opts?: ScanOptions): ScannedSkill[] {
  return collectHermesSkills();
}

function scanMemoryFiles(opts?: ScanOptions): ScannedMemoryFile[] {
  const h = home();
  const hermesHome = process.env.HERMES_HOME || join(h, '.hermes');
  const out: ScannedMemoryFile[] = [];
  const push = (p: string) => {
    const text = readIfExists(p);
    if (text == null || !text.trim()) return;
    out.push({ messages: [{ role: 'user', content: text }], sourceKey: `memory:${KIND}:${p}`, origin: p });
  };
  push(join(hermesHome, 'USER.md'));
  const mem = join(hermesHome, 'memories');
  if (existsSync(mem)) for (const f of listMdRecursive(mem)) push(f);
  return out;
}

function scanSessions(sessionsDir?: string, _opts?: ScanOptions): ScannedSession[] {
  if (sessionsDir) return scanSessionsOverride(KIND, sessionsDir);
  const out: ScannedSession[] = [];
  const hermesHome = process.env.HERMES_HOME || join(home(), '.hermes');
  const dbPath = join(hermesHome, 'state.db');
  if (!existsSync(dbPath)) return out;
  let db: unknown;
  try {
    const require = createRequire(import.meta.url);
    let sqlite: { DatabaseSync?: unknown; Database?: unknown; default?: { Database?: unknown } };
    try {
      sqlite = require('node:sqlite');
    } catch {
      // node:sqlite 是 Node >= 22.5 的实验性内置模块；老版本无此模块，
      // 直接跳过 db 会话扫描（skills/memory 不受影响），不打印警告。
      return out;
    }
    const Database = sqlite.DatabaseSync ?? sqlite.Database ?? sqlite.default?.Database;
    db = new Database(dbPath, { readOnly: true });
  } catch (e) {
    console.warn(`[warn] 无法打开 state.db (${dbPath}): ${(e as Error).message}`);
    return out;
  }
  try {
    const rows = (db as { prepare: (s: string) => { all: () => unknown[] } }).prepare(
      'SELECT session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp FROM messages ORDER BY session_id, id'
    ).all() as Array<{ session_id: string; role: string; content: unknown; tool_call_id?: string | null; tool_calls?: string | null; tool_name?: string | null; timestamp?: number | null }>;
    const bySession = new Map<string, ImportMessage[]>();
    for (const r of rows) {
      const msgs = hermesRowToMessages(r);
      if (!msgs.length) continue;
      if (!bySession.has(r.session_id)) bySession.set(r.session_id, []);
      bySession.get(r.session_id)!.push(...msgs);
    }
    for (const [sid, msgs] of bySession) {
      // 补 recIdx：否则 toMemoryMessages 会按 recIdx ?? -1 把所有消息塌缩成一条。
      msgs.forEach((m, i) => { m.recIdx = i; });
      if (msgs.length) out.push({ sessionId: sid, messages: msgs, sourceKey: `session:${KIND}:${dbPath}#${sid}`, origin: dbPath });
    }
  } catch (e) {
    console.warn(`[warn] 读取 state.db 失败 (${dbPath}): ${(e as Error).message}`);
  } finally {
    try { (db as { close?: () => void }).close?.(); } catch { /* ignore */ }
  }
  return out;
}

/**
 * 把 hermes state.db 的一行 message 归一化成 pipeline 内部的 ImportMessage[]。
 * 关键点：hermes 把工具结果存为 role='tool'（OpenAI 风格），且把配对信息单独存进
 * tool_call_id / tool_calls / tool_name 列。必须归一化为 tool_call/tool_result + tool_call_id 配对，否则：
 *  - skill 链路收到裸 'tool' 角色（不在 user/assistant/tool_call/tool_result/system）→ 40001；
 *  - memory 链路收到裸 'tool' 角色（不在 user/assistant/system）→ 400。
 * 同时补 memRole，使 memory 链路映射出合法角色（tool_result→user、tool_call→assistant）。
 */
function hermesRowToMessages(r: {
  role: string;
  content: unknown;
  tool_call_id?: string | null;
  tool_calls?: string | null;
  tool_name?: string | null;
  timestamp?: number | null;
}): ImportMessage[] {
  const content = extractText(r.content);
  if (!content) return [];
  const ts = typeof r.timestamp === 'number' ? Math.round(r.timestamp * 1000) : undefined;

  // assistant 带 tool_calls：拆成 assistant 文本 + 若干 tool_call
  if (r.role === 'assistant' && r.tool_calls) {
    let calls: any[] = [];
    try { calls = JSON.parse(r.tool_calls); } catch { /* ignore */ }
    if (Array.isArray(calls) && calls.length) {
      const out: ImportMessage[] = [];
      if (content.trim()) out.push({ role: 'assistant', content, ts, memRole: 'assistant', hasToolUse: true });
      for (const c of calls) {
        const args = c?.arguments ?? c?.input ?? c?.function?.arguments ?? c;
        out.push({
          role: 'tool_call',
          content: typeof args === 'string' ? args : JSON.stringify(args ?? ''),
          tool_call_id: c?.id ?? c?.tool_call_id ?? undefined,
          tool_name: c?.name ?? c?.function?.name ?? undefined,
          ts,
          memRole: 'assistant',
          hasToolUse: true,
        });
      }
      return out;
    }
  }

  // 工具结果：hermes 存为 role='tool' → 归一化为 tool_result（带配对锚点）
  if (r.role === 'tool') {
    return [{
      role: 'tool_result',
      content,
      tool_call_id: r.tool_call_id ?? undefined,
      tool_name: r.tool_name ?? undefined,
      ts,
      memRole: 'user',
    }];
  }

  // user / assistant / system 原样保留，并补 memRole
  const memRole = r.role === 'system' ? 'system' : r.role === 'assistant' ? 'assistant' : 'user';
  return [{ role: r.role, content, ts, memRole }];
}


function scanSessionsOverride(kind: AgentKind, sessionsDir: string): ScannedSession[] {
  const out: ScannedSession[] = [];
  if (!existsSync(sessionsDir)) return out;
  const st = statSync(sessionsDir);
  const jsonlFiles = st.isDirectory()
    ? listJsonlRecursive(sessionsDir)
    : sessionsDir.endsWith('.jsonl')
      ? [sessionsDir]
      : [];
  const jsonFiles = st.isDirectory()
    ? readdirSync(sessionsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => join(sessionsDir, f))
    : sessionsDir.endsWith('.json')
      ? [sessionsDir]
      : [];
  for (const full of jsonlFiles) {
    const text = readFileSync(full, 'utf-8');
    const msgs = parseJsonlLines(text);
    if (!msgs.length) continue;
    out.push({
      sessionId: extractCodexSessionId(full, text),
      messages: msgs,
      sourceKey: `session:${kind}:${full}`,
      origin: full,
    });
  }
  for (const full of jsonFiles) {
    const msgs = normalizeResponsesJson(full);
    if (!msgs.length) continue;
    out.push({
      sessionId: basename(full, '.json'),
      messages: msgs,
      sourceKey: `session:${kind}:${full}`,
      origin: full,
    });
  }
  return out;
}
  return { kind: KIND, scanSkills, scanSessions, scanSessionsOverride, detect };
}
function make_workbuddyAdapter(): IdeAdapter {
const KIND = 'workbuddy' as const;

function wbRoot(): string {
  return join(home(), '.workbuddy');
}

function detect(): boolean {
  return existsSync(join(home(), '.workbuddy'));
}

function scanSkills(opts?: ScanOptions): ScannedSkill[] {
  const cwd = projectCwd(opts);
  const h = home();
  const roots = [join(h, '.workbuddy', 'skills'), join(cwd, '.workbuddy', 'skills'), join(cwd, 'workbuddy', 'skills')];
  return collectSkillDirs(KIND, roots);
}

function scanMemoryFiles(opts?: ScanOptions): ScannedMemoryFile[] {
  const cwd = projectCwd(opts);
  const h = home();
  const files: string[] = [];
  const names = ['SOUL.md', 'USER.md', 'IDENTITY.md', 'MEMORY.md'];
  for (const f of names) {
    for (const base of [join(h, '.workbuddy'), join(cwd, '.workbuddy'), join(cwd, 'workbuddy')]) {
      files.push(join(base, f));
    }
  }
  for (const base of [join(h, '.workbuddy'), join(cwd, '.workbuddy'), join(cwd, 'workbuddy')]) {
    const mem = join(base, 'memory');
    if (existsSync(mem)) files.push(...listMd(mem));
  }
  const out: ScannedMemoryFile[] = [];
  for (const p of files) {
    const text = readIfExists(p);
    if (text == null || !text.trim()) continue;
    out.push({ messages: [{ role: 'user', content: text }], sourceKey: `memory:${KIND}:${p}`, origin: p });
  }
  return out;
}

function scanWbSessions(root: string, _opts?: ScanOptions): ScannedSession[] {
  const out: ScannedSession[] = [];
  for (const f of readdirSync(root)) {
    if (!f.endsWith('.jsonl') && !f.endsWith('.json')) continue;
    const full = join(root, f);
    const text = readFileSync(full, 'utf-8');
    const msgs = f.endsWith('.json') ? normalizeResponsesJson(full) : parseJsonlLines(text);
    if (!msgs.length) continue;
    out.push({ sessionId: basename(f, f.endsWith('.json') ? '.json' : '.jsonl'), messages: msgs, sourceKey: `session:${KIND}:${full}`, origin: full });
  }
  const projectsRoot = join(root, 'projects');
  if (existsSync(projectsRoot)) {
    for (const proj of readdirSync(projectsRoot)) {
      const dir = join(projectsRoot, proj);
      if (!statSync(dir).isDirectory()) continue;
      for (const full of listJsonlRecursive(dir)) {
        const msgs = parseJsonlLines(readFileSync(full, 'utf-8'));
        if (!msgs.length) continue;
        out.push({ sessionId: `${proj}/${basename(full, '.jsonl')}`, messages: msgs, sourceKey: `session:${KIND}:${full}`, origin: full });
      }
    }
  }
  return out;
}

function scanSessions(sessionsDir?: string, opts?: ScanOptions): ScannedSession[] {
  if (sessionsDir) return scanSessionsOverride(KIND, sessionsDir);
  return scanWbSessions(wbRoot(), opts);
}


function scanSessionsOverride(kind: AgentKind, sessionsDir: string): ScannedSession[] {
  const out: ScannedSession[] = [];
  if (!existsSync(sessionsDir)) return out;
  const st = statSync(sessionsDir);
  const jsonlFiles = st.isDirectory()
    ? listJsonlRecursive(sessionsDir)
    : sessionsDir.endsWith('.jsonl')
      ? [sessionsDir]
      : [];
  const jsonFiles = st.isDirectory()
    ? readdirSync(sessionsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => join(sessionsDir, f))
    : sessionsDir.endsWith('.json')
      ? [sessionsDir]
      : [];
  for (const full of jsonlFiles) {
    const text = readFileSync(full, 'utf-8');
    const msgs = parseJsonlLines(text);
    if (!msgs.length) continue;
    out.push({
      sessionId: extractCodexSessionId(full, text),
      messages: msgs,
      sourceKey: `session:${kind}:${full}`,
      origin: full,
    });
  }
  for (const full of jsonFiles) {
    const msgs = normalizeResponsesJson(full);
    if (!msgs.length) continue;
    out.push({
      sessionId: basename(full, '.json'),
      messages: msgs,
      sourceKey: `session:${kind}:${full}`,
      origin: full,
    });
  }
  return out;
}
  return { kind: KIND, scanSkills, scanSessions, scanSessionsOverride, detect };
}

export const ADAPTERS: Record<string, IdeAdapter> = {
  openclaw: make_openclawAdapter(), codebuddy: make_codebuddyAdapter(), codex: make_codexAdapter(), 'claude-code': make_claude_codeAdapter(), dsh: make_dshAdapter(), hermes: make_hermesAdapter(), workbuddy: make_workbuddyAdapter(),
};

/** 各 adapter 在项目目录（cwd）下的专属 marker 目录（用于「项目本地优先」判定）。 */
const CWD_MARKER_DIRS: Record<string, string[]> = {
  openclaw: ['.openclaw'],
  codebuddy: ['.codebuddy'],
  codex: ['.agents'],
  'claude-code': ['.claude'],
  dsh: ['.dsh'],
  hermes: ['.hermes'],
  workbuddy: ['.workbuddy', 'workbuddy'],
};

/** 第一优先：当前项目目录（cwd，或 --workspace 指定目录）里是否存在某个 adapter 的专属 marker 目录（不看 home）。 */
function detectByCwdMarker(workspace?: string): string | undefined {
  const cwd = projectCwd(workspace ? { workspace } : undefined);
  for (const k of Object.keys(ADAPTERS)) {
    const markers = CWD_MARKER_DIRS[k];
    if (markers && markers.some((m) => existsSync(join(cwd, m)))) return k;
  }
  return undefined;
}

/** auto：先检测「当前路径（cwd，或 --workspace 指定目录）」的项目专属目录，再回退到「家目录 / 环境变量」。 */
export function resolveSource(source: string, workspace?: string): string {
  const s = (source || 'auto').trim();
  if (s !== 'auto' && ADAPTERS[s]) return s;
  // 第一级：当前路径（cwd / --workspace）的项目专属 marker 目录
  const byCwd = detectByCwdMarker(workspace);
  if (byCwd) return byCwd;
  // 第二级：家目录 / 环境变量 marker（detect 已不含 cwd 判定）
  for (const k of Object.keys(ADAPTERS)) {
    const a = ADAPTERS[k];
    if (a.detect && a.detect()) return k;
  }
  return 'openclaw';
}

function currentAdapter(): IdeAdapter {
  return ADAPTERS[KIND] ?? ADAPTERS.openclaw;
}

export function scanSkills(opts?: ScanOptions): ScannedSkill[] {
  return currentAdapter().scanSkills(opts);
}
export function scanSessions(sessionsDir?: string, opts?: ScanOptions): ScannedSession[] {
  return currentAdapter().scanSessions(sessionsDir, opts);
}
export function scanSessionsOverride(kind: AgentKind, sessionsDir: string): ScannedSession[] {
  return currentAdapter().scanSessionsOverride(kind, sessionsDir);
}

runIfMain(import.meta.url);
