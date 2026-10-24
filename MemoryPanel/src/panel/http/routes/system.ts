/**
 * routes/system.ts — 面板「系统状态」菜单的后端支撑。
 *
 * 提供四个能力：
 *   GET  /system/health    健康看板：core / proxy / knowledge / redis / 计费上报
 *   GET  /system/config    当前生效配置一览（脱敏）
 *   GET  /system/usage     用量统计（含「自定义上游」这一项的贡献单列）
 *   GET  /system/vector    读取向量检索（embedding）配置
 *   POST /system/vector    写入向量检索配置（备份 → 写 → 回读校验 → 失败自动还原）
 *
 * 配置来源说明：
 *   - Core 配置：挂载到容器内的 tdai-gateway.yaml（路径由 PANEL_CORE_CONFIG_PATH 指定）
 *   - Proxy 配置：挂载到容器内的 proxy config.yaml（路径由 PANEL_PROXY_CONFIG_PATH 指定）
 *   两者都只读脱敏后下发，密钥永远不做完整回显。
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import type { Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import { respondControlError, respondEnvelope } from '../envelope.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';

const CORE_CONFIG_PATH =
  process.env.PANEL_CORE_CONFIG_PATH ?? '/app/core-config/tdai-gateway.yaml';
const PROXY_CONFIG_PATH =
  process.env.PANEL_PROXY_CONFIG_PATH ?? '/app/proxy-config/config.yaml';
const PROXY_BASE_URL = process.env.PANEL_PROXY_BASE_URL ?? 'http://tdai-proxy:8096';
const KNOWLEDGE_BASE_URL = process.env.PANEL_KNOWLEDGE_BASE_URL ?? 'http://127.0.0.1:8424';

const PROBE_TIMEOUT_MS = 6000;

// ── 脱敏 ────────────────────────────────────────────────────────────────────

/** 密钥脱敏：短串全遮，长串保留前 6 后 4。 */
function maskSecret(value: unknown): string {
  if (typeof value !== 'string' || value === '') return '';
  if (value.length <= 12) return '•'.repeat(Math.min(value.length, 8));
  return `${value.slice(0, 6)}••••${value.slice(-4)}`;
}

/** 把任意对象里的敏感键做脱敏（递归，深度上限保护）。 */
function maskTree(input: unknown, depth = 0): unknown {
  if (depth > 6) return '…';
  if (Array.isArray(input)) return input.map((v) => maskTree(v, depth + 1));
  if (!input || typeof input !== 'object') return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (/key|secret|token|password/i.test(k) && typeof v === 'string') {
      out[k] = maskSecret(v);
    } else {
      out[k] = maskTree(v, depth + 1);
    }
  }
  return out;
}

// ── 极简 YAML 读取（只取需要的标量，避免引入依赖）────────────────────────

function scalarOf(raw: string): string {
  return raw
    .slice(raw.indexOf(':') + 1)
    .trim()
    .replace(/^["']|["']$/g, '');
}

/**
 * 读取 `key:` 后的标量值。
 * 传 parent 时只在 parent 块内查找（遇到缩进 <= parent 的行即认为块结束）。
 */
function readScalar(text: string, key: string, parent?: string): string | null {
  const lines = text.split(/\r?\n/);
  let inParent = false;
  let parentIndent = -1;
  for (const raw of lines) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    if (!parent) {
      if (raw.trim().startsWith(`${key}:`)) return scalarOf(raw);
      continue;
    }
    if (raw.trim().startsWith(`${parent}:`)) {
      inParent = true;
      parentIndent = indent;
      continue;
    }
    if (!inParent) continue;
    if (indent <= parentIndent) {
      inParent = false;
      continue;
    }
    if (raw.trim().startsWith(`${key}:`)) return scalarOf(raw);
  }
  return null;
}

/**
 * 定位 `embedding:` 块：[起始行, 结束行)（结束于下一个缩进更小或相等的非空非注释行）。
 */
function findBlockRange(lines: string[], key: string): { start: number; end: number; indent: number } | null {
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!raw || !raw.trim() || raw.trimStart().startsWith('#')) continue;
    if (!raw.trim().startsWith(`${key}:`)) continue;
    const indent = raw.length - raw.trimStart().length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (!line || !line.trim() || line.trimStart().startsWith('#')) continue;
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent <= indent) {
        end = j;
        break;
      }
    }
    return { start: i, end, indent };
  }
  return null;
}

// ── 健康探测 ────────────────────────────────────────────────────────────────

interface ComponentHealth {
  name: string;
  status: 'ok' | 'warn' | 'down' | 'unknown';
  detail: string;
  latencyMs?: number;
}

async function probe(url: string, name: string): Promise<ComponentHealth> {
  const started = Date.now();
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const latencyMs = Date.now() - started;
    return {
      name,
      status: resp.ok ? 'ok' : 'warn',
      detail: resp.ok ? `HTTP ${resp.status}` : `HTTP ${resp.status} ${resp.statusText}`,
      latencyMs,
    };
  } catch (err) {
    return {
      name,
      status: 'down',
      detail: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    };
  }
}

/** 代理侧补充探针：用量统计端点（顺带验证自定义上游统计链路可用）。 */
async function probeProxyUsage(): Promise<ComponentHealth> {
  const started = Date.now();
  try {
    const resp = await fetch(`${PROXY_BASE_URL}/internal/upstream-usage`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - started;
    if (!resp.ok) {
      return { name: 'proxy_usage', status: 'warn', detail: `HTTP ${resp.status}`, latencyMs };
    }
    const data = (await resp.json()) as { items?: unknown[] };
    return {
      name: 'proxy_usage',
      status: 'ok',
      detail: `自定义上游统计可用，当前 ${Array.isArray(data.items) ? data.items.length : 0} 个维度`,
      latencyMs,
    };
  } catch (err) {
    return {
      name: 'proxy_usage',
      status: 'down',
      detail: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    };
  }
}

// ── 路由注册 ────────────────────────────────────────────────────────────────

export function registerSystemRoutes(api: Hono, deps: PanelDeps): void {
  // 1) 健康看板
  api.get('/system/health', validatePanelMetaHeaders(deps), async (c) => {
    const panelMeta = c.get('panelMeta');
    const coreUrl = String(panelMeta?.gatewayEndpoint ?? '');

    const checks: ComponentHealth[] = [];
    checks.push({ name: 'panel', status: 'ok', detail: '面板服务正常' });

    if (coreUrl) {
      checks.push(await probe(`${coreUrl.replace(/\/$/, '')}/health`, 'core'));
    } else {
      checks.push({ name: 'core', status: 'unknown', detail: '未配置 gateway endpoint' });
    }

    checks.push(await probe(`${PROXY_BASE_URL}/health`, 'proxy'));
    checks.push(await probeProxyUsage());
    checks.push(await probe(`${KNOWLEDGE_BASE_URL}/health`, 'knowledge'));

    // redis / 计费上报：从 Proxy 配置读（面板不直连 redis，避免误判）
    let redisEnabled: boolean | null = null;
    let creditReportUrl = '';
    let creditReportEnabled = false;
    if (existsSync(PROXY_CONFIG_PATH)) {
      try {
        const text = readFileSync(PROXY_CONFIG_PATH, 'utf8');
        redisEnabled = /^\s*redis:\s*$/m.test(text)
          ? !/enabled:\s*false/.test(text.slice(text.search(/^\s*redis:\s*$/m)).slice(0, 400))
          : null;
        const creditBlock = /creditReport:\s*\n([\s\S]{0,400}?)(?=\n\S|$)/.exec(text);
        const creditBody = creditBlock?.[1] ?? '';
        if (creditBlock) {
          creditReportEnabled = !/enabled:\s*false/.test(creditBody);
          const urlMatch = /url:\s*["']?([^"'\n]+)/.exec(creditBody);
          creditReportUrl = urlMatch ? (urlMatch[1] ?? '').trim() : '';
        }
      } catch {
        /* 读配置失败不阻断健康看板 */
      }
    }

    checks.push({
      name: 'redis',
      status: redisEnabled === null ? 'unknown' : redisEnabled ? 'ok' : 'warn',
      detail:
        redisEnabled === null
          ? '未能读取代理配置（未挂载 config.yaml）'
          : redisEnabled
            ? '代理配置已启用'
            : '代理配置为关闭（当前不影响主链路）',
    });
    checks.push({
      name: 'credit_report',
      status: !creditReportEnabled ? 'warn' : creditReportUrl ? 'ok' : 'unknown',
      detail: !creditReportEnabled
        ? '计费上报未启用'
        : creditReportUrl
          ? `上报地址 ${creditReportUrl}`
          : '已启用但未配置上报地址',
    });

    return respondEnvelope(c, {
      code: 0,
      message: 'ok',
      request_id: c.get('reqId') ?? '',
      data: { checks, generatedAt: new Date().toISOString() },
    });
  });

  // 2) 当前配置一览（脱敏）
  api.get('/system/config', validatePanelMetaHeaders(deps), (c) => {
    const sections: Array<{ source: string; path: string; exists: boolean; data: unknown }> = [];

    for (const [source, filePath] of [
      ['core', CORE_CONFIG_PATH],
      ['proxy', PROXY_CONFIG_PATH],
    ] as const) {
      if (!existsSync(filePath)) {
        sections.push({ source, path: filePath, exists: false, data: null });
        continue;
      }
      try {
        const text = readFileSync(filePath, 'utf8');
        // 只做行级脱敏：任何 key/secret/token/password 出现的值都打码
        const masked = text
          .split(/\r?\n/)
          .map((line) =>
            /^\s*([A-Za-z0-9_]*(?:key|secret|token|password)[A-Za-z0-9_]*)\s*:\s*(.+)$/i.test(line)
              ? line.replace(
                  /^(\s*[A-Za-z0-9_]*(?:key|secret|token|password)[A-Za-z0-9_]*\s*:\s*)(.+)$/i,
                  (_m, head: string, value: string) => head + maskSecret(value.trim().replace(/^["']|["']$/g, '')),
                )
              : line,
          )
          .join('\n');
        sections.push({ source, path: filePath, exists: true, data: masked });
      } catch (err) {
        sections.push({
          source,
          path: filePath,
          exists: true,
          data: `读取失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    return respondEnvelope(c, {
      code: 0,
      message: 'ok',
      request_id: c.get('reqId') ?? '',
      data: { sections: maskTree(sections) },
    });
  });

  // 3) 用量统计（含自定义上游贡献单列）
  api.get('/system/usage', validatePanelMetaHeaders(deps), async (c) => {
    try {
      const resp = await fetch(`${PROXY_BASE_URL}/internal/upstream-usage`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!resp.ok) {
        return respondControlError(c, 502, `PROXY_USAGE_HTTP_${resp.status}`);
      }
      const data = await resp.json();
      return respondEnvelope(c, {
        code: 0,
        message: 'ok',
        request_id: c.get('reqId') ?? '',
        data,
      });
    } catch (err) {
      return respondControlError(
        c,
        502,
        `PROXY_USAGE_UNREACHABLE: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // 4) 向量检索配置：读
  api.get('/system/vector', validatePanelMetaHeaders(deps), (c) => {
    if (!existsSync(CORE_CONFIG_PATH)) {
      return respondControlError(c, 404, `CORE_CONFIG_NOT_FOUND: ${CORE_CONFIG_PATH}`);
    }
    const text = readFileSync(CORE_CONFIG_PATH, 'utf8');
    // 只在 embedding 块内取值：其它块（如 llm）也有 baseUrl / model / apiKey，
    // 全局兜底会把别人的字段当成向量配置显示出来，属于误导。
    const pick = (key: string) => readScalar(text, key, 'embedding') ?? '';
    return respondEnvelope(c, {
      code: 0,
      message: 'ok',
      request_id: c.get('reqId') ?? '',
      data: {
        path: CORE_CONFIG_PATH,
        provider: pick('provider'),
        baseUrl: pick('baseUrl') || pick('base_url'),
        model: pick('model'),
        apiKey: maskSecret(pick('apiKey') || pick('api_key')),
        dimensions: pick('dimensions'),
        enabled: pick('enabled'),
        restartRequired: true,
      },
    });
  });

  // 5) 向量检索配置：写（备份 → 写 → 回读校验 → 失败还原）
  api.post('/system/vector', validatePanelMetaHeaders(deps), async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    } catch {
      body = {};
    }

    if (!existsSync(CORE_CONFIG_PATH)) {
      return respondControlError(c, 404, `CORE_CONFIG_NOT_FOUND: ${CORE_CONFIG_PATH}`);
    }

    const fields: Array<[string, string]> = [
      ['provider', 'provider'],
      ['baseUrl', 'baseUrl'],
      ['model', 'model'],
      ['apiKey', 'apiKey'],
      ['dimensions', 'dimensions'],
      ['enabled', 'enabled'],
    ];
    const updates: Record<string, string> = {};
    for (const [bodyKey, yamlKey] of fields) {
      const value = body[bodyKey];
      if (value === undefined || value === null || value === '') continue;
      // apiKey 传掩码（含 •）视为"不改"
      if (bodyKey === 'apiKey' && String(value).includes('•')) continue;
      updates[yamlKey] = String(value);
    }
    if (Object.keys(updates).length === 0) {
      return respondControlError(c, 400, 'NO_CHANGES');
    }

    const backupPath = `${CORE_CONFIG_PATH}.bak-${Date.now()}`;
    let original = '';
    try {
      original = readFileSync(CORE_CONFIG_PATH, 'utf8');
      copyFileSync(CORE_CONFIG_PATH, backupPath);

      const lines = original.split(/\r?\n/);
      const block = findBlockRange(lines, 'embedding');
      if (!block) {
        return respondControlError(c, 400, 'EMBEDDING_BLOCK_NOT_FOUND');
      }

      // 在块内替换已有键 / 追加缺失键
      const childIndent = ' '.repeat(block.indent + 2);
      const next: string[] = [];
      const handled = new Set<string>();
      for (let i = block.start + 1; i < block.end; i += 1) {
        const line = lines[i] ?? '';
        const m = /^(\s*)([A-Za-z0-9_]+)\s*:/.exec(line);
        const keyName = m ? (m[2] ?? '') : '';
        if (keyName && Object.prototype.hasOwnProperty.call(updates, keyName)) {
          next.push(`${childIndent}${keyName}: ${formatYamlValue(updates[keyName] ?? '')}`);
          handled.add(keyName);
          continue;
        }
        next.push(line);
      }
      for (const [k, v] of Object.entries(updates)) {
        if (handled.has(k)) continue;
        next.push(`${childIndent}${k}: ${formatYamlValue(v)}`);
      }

      const output = [
        ...lines.slice(0, block.start + 1),
        ...next,
        ...lines.slice(block.end),
      ].join('\n');
      writeFileSync(CORE_CONFIG_PATH, output, 'utf8');

      // 回读校验：每个写入的字段都必须能在新文件里读到
      const verifyText = readFileSync(CORE_CONFIG_PATH, 'utf8');
      const failed: string[] = [];
      for (const [k, v] of Object.entries(updates)) {
        const got = readScalar(verifyText, k, 'embedding');
        if (!got || got !== v) failed.push(k);
      }
      if (failed.length > 0) {
        throw new Error(`回读校验失败：${failed.join(', ')}`);
      }

      deps.logger.info('vector config updated', {
        keys: Object.keys(updates),
        backup: backupPath,
      });

      return respondEnvelope(c, {
        code: 0,
        message: 'ok',
        request_id: c.get('reqId') ?? '',
        data: {
          ok: true,
          updated: Object.keys(updates),
          backupPath,
          restartRequired: true,
          restartHint: '向量检索配置需重启 Memory Core 后生效（docker restart tdai-memory-core）',
        },
      });
    } catch (err) {
      // 失败自动还原
      if (original) {
        try {
          writeFileSync(CORE_CONFIG_PATH, original, 'utf8');
        } catch {
          /* 还原失败也要把错误抛出去 */
        }
      }
      deps.logger.error('vector config update failed, rolled back', {
        error: err instanceof Error ? err.message : String(err),
        backup: backupPath,
      });
      return respondControlError(
        c,
        500,
        `VECTOR_UPDATE_FAILED_ROLLED_BACK: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}

/** 写入 YAML 标量：含特殊字符或看起来像布尔/数字之外的都加引号。 */
function formatYamlValue(value: string): string {
  if (/^(true|false|null|~)$/i.test(value)) return value;
  if (/^-?\d+(\.\d+)?$/.test(value)) return value;
  if (/[:#\[\]{}&*!|>'"%@`]/.test(value) || value.trim() !== value) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}
