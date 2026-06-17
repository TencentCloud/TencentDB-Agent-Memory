#!/usr/bin/env node
/**
 * memory-client.mjs — CodeBuddy ⇄ TencentDB Agent Memory Gateway 桥接客户端。
 *
 * 用 Node.js 内置全局 `fetch`（Node ≥ 18）封装 Gateway HTTP 端点，零额外依赖。
 * 供 CodeBuddy Agent 在终端直接调用，输出精简文本供 Agent 消费。
 *
 * 子命令：
 *   recall                --query <q> [--session <key>] [--timeout 3000]
 *   capture               --user <u> --assistant <a> [--session <key>] [--session-id <id>]
 *   search-memories       --query <q> [--limit 5] [--type <t>] [--scene <s>]
 *   search-conversations  --query <q> [--limit 5] [--session <key>]
 *   health
 *
 * 公共选项：
 *   --base-url <url>   默认 http://127.0.0.1:8420，或环境变量 TDAI_GATEWAY_BASE_URL
 *   --api-key  <key>   可选 Bearer，或环境变量 TDAI_GATEWAY_API_KEY
 *   --session  <key>   覆盖 session_key（默认读取同目录 .session-scope，再降级 codebuddy:global）
 *   --timeout  <ms>    单次请求超时；recall 默认 3000ms，其它默认 10000ms
 *   --json             以原始 JSON 输出（默认输出精简文本）
 *
 * 设计原则：
 *   - recall 在用户等待路径上：短超时 + 失败静默降级（退出码 0，输出空），绝不阻塞回答。
 *   - capture/search 失败：stderr 记录诊断，退出码非 0，但不抛堆栈到 stdout。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_BASE_URL = "http://127.0.0.1:8420";
const DEFAULT_TIMEOUT_MS = 10_000;
const RECALL_TIMEOUT_MS = 3_000;
const GLOBAL_SESSION = "codebuddy:global";

// ----------------------------------------------------------------------------
// 参数解析
// ----------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith("--")) {
      const key = tok.slice(2);
      // 布尔 flag
      if (key === "json") {
        args[key] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(tok);
    }
  }
  return args;
}

// ----------------------------------------------------------------------------
// 配置解析
// ----------------------------------------------------------------------------

function resolveBaseUrl(args) {
  const raw = args["base-url"] || process.env.TDAI_GATEWAY_BASE_URL || DEFAULT_BASE_URL;
  return String(raw).replace(/\/+$/, "");
}

function resolveApiKey(args) {
  const raw = args["api-key"] || process.env.TDAI_GATEWAY_API_KEY || "";
  const key = String(raw).trim();
  return key || null;
}

/**
 * session_key 解析顺序：
 *   1. --session 显式参数
 *   2. 环境变量 TDAI_MEMORY_SESSION_KEY
 *   3. 同目录下 .session-scope 文件（安装脚本写入）
 *   4. 降级为全局命名空间 codebuddy:global
 */
function resolveSessionKey(args) {
  if (args.session && typeof args.session === "string") return args.session.trim();
  const fromEnv = (process.env.TDAI_MEMORY_SESSION_KEY || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const scope = readFileSync(path.join(__dirname, ".session-scope"), "utf-8").trim();
    if (scope) return scope;
  } catch {
    // 文件不存在 → 降级
  }
  return GLOBAL_SESSION;
}

// ----------------------------------------------------------------------------
// HTTP helpers（内置 fetch + AbortController 超时）
// ----------------------------------------------------------------------------

function buildHeaders(apiKey, withContentType) {
  const headers = {};
  if (withContentType) headers["Content-Type"] = "application/json";
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
}

async function httpPost(baseUrl, apiKey, route, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${baseUrl}${route}`, {
      method: "POST",
      headers: buildHeaders(apiKey, true),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${route}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

async function httpGet(baseUrl, apiKey, route, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${baseUrl}${route}`, {
      method: "GET",
      headers: buildHeaders(apiKey, false),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${route}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------------------
// 子命令
// ----------------------------------------------------------------------------

/**
 * recall：失败静默降级。任何错误都吞掉，输出空、退出 0，绝不阻塞回答。
 */
async function cmdRecall(args) {
  const query = args.query;
  if (!query || typeof query !== "string") {
    // 没有 query 也按降级处理，不报错中断
    process.stderr.write("[memory-client] recall: missing --query, skip\n");
    return 0;
  }
  const baseUrl = resolveBaseUrl(args);
  const apiKey = resolveApiKey(args);
  const sessionKey = resolveSessionKey(args);
  const timeout = Number(args.timeout) || RECALL_TIMEOUT_MS;
  try {
    const res = await httpPost(
      baseUrl,
      apiKey,
      "/recall",
      { query, session_key: sessionKey },
      timeout,
    );
    if (args.json) {
      process.stdout.write(JSON.stringify(res));
      return 0;
    }
    const context = (res && res.context) || "";
    if (context.trim()) {
      process.stdout.write(context.trim() + "\n");
    }
    // 无 context → 输出空（正常），退出 0
    return 0;
  } catch (err) {
    // 静默降级：仅 stderr，stdout 保持空
    process.stderr.write(`[memory-client] recall degraded: ${errMsg(err)}\n`);
    return 0;
  }
}

async function cmdCapture(args) {
  const user = args.user;
  const assistant = args.assistant;
  if (!user || !assistant) {
    process.stderr.write("[memory-client] capture: 需要 --user 和 --assistant\n");
    return 2;
  }
  const baseUrl = resolveBaseUrl(args);
  const apiKey = resolveApiKey(args);
  const sessionKey = resolveSessionKey(args);
  const timeout = Number(args.timeout) || DEFAULT_TIMEOUT_MS;
  const body = {
    user_content: String(user),
    assistant_content: String(assistant),
    session_key: sessionKey,
  };
  if (args["session-id"] && typeof args["session-id"] === "string") {
    body.session_id = args["session-id"];
  }
  try {
    const res = await httpPost(baseUrl, apiKey, "/capture", body, timeout);
    if (args.json) {
      process.stdout.write(JSON.stringify(res));
    } else {
      process.stdout.write(
        `captured: l0_recorded=${res.l0_recorded ?? 0} scheduler_notified=${res.scheduler_notified ?? false}\n`,
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(`[memory-client] capture failed: ${errMsg(err)}\n`);
    return 1;
  }
}

async function cmdSearchMemories(args) {
  const query = args.query;
  if (!query) {
    process.stderr.write("[memory-client] search-memories: 需要 --query\n");
    return 2;
  }
  const baseUrl = resolveBaseUrl(args);
  const apiKey = resolveApiKey(args);
  const timeout = Number(args.timeout) || DEFAULT_TIMEOUT_MS;
  const body = { query: String(query), limit: Number(args.limit) || 5 };
  if (args.type && typeof args.type === "string") body.type = args.type;
  if (args.scene && typeof args.scene === "string") body.scene = args.scene;
  try {
    const res = await httpPost(baseUrl, apiKey, "/search/memories", body, timeout);
    if (args.json) {
      process.stdout.write(JSON.stringify(res));
    } else {
      const text = (res && res.results) || "";
      process.stdout.write((text.trim() || "(no memories found)") + "\n");
    }
    return 0;
  } catch (err) {
    process.stderr.write(`[memory-client] search-memories failed: ${errMsg(err)}\n`);
    return 1;
  }
}

async function cmdSearchConversations(args) {
  const query = args.query;
  if (!query) {
    process.stderr.write("[memory-client] search-conversations: 需要 --query\n");
    return 2;
  }
  const baseUrl = resolveBaseUrl(args);
  const apiKey = resolveApiKey(args);
  const timeout = Number(args.timeout) || DEFAULT_TIMEOUT_MS;
  const body = { query: String(query), limit: Number(args.limit) || 5 };
  // 仅当显式传 --session 时才按 session 过滤；默认跨 session 检索
  if (args.session && typeof args.session === "string") body.session_key = args.session.trim();
  try {
    const res = await httpPost(baseUrl, apiKey, "/search/conversations", body, timeout);
    if (args.json) {
      process.stdout.write(JSON.stringify(res));
    } else {
      const text = (res && res.results) || "";
      process.stdout.write((text.trim() || "(no conversations found)") + "\n");
    }
    return 0;
  } catch (err) {
    process.stderr.write(`[memory-client] search-conversations failed: ${errMsg(err)}\n`);
    return 1;
  }
}

async function cmdHealth(args) {
  const baseUrl = resolveBaseUrl(args);
  const apiKey = resolveApiKey(args);
  const timeout = Number(args.timeout) || 3_000;
  try {
    const res = await httpGet(baseUrl, apiKey, "/health", timeout);
    if (args.json) {
      process.stdout.write(JSON.stringify(res));
    } else {
      // status: ok | degraded（向量库不可用）
      process.stdout.write(`${res.status || "unknown"}\n`);
    }
    return 0;
  } catch (err) {
    if (args.json) {
      process.stdout.write(JSON.stringify({ status: "down", error: errMsg(err) }));
    } else {
      process.stdout.write("down\n");
    }
    process.stderr.write(`[memory-client] health: ${errMsg(err)}\n`);
    return 1;
  }
}

// ----------------------------------------------------------------------------
// 工具
// ----------------------------------------------------------------------------

function errMsg(err) {
  if (err && err.name === "AbortError") return "request timed out";
  return err instanceof Error ? err.message : String(err);
}

function usage() {
  process.stderr.write(
    `memory-client.mjs — TencentDB Agent Memory Gateway 桥接客户端

用法:
  node memory-client.mjs recall                --query <q> [--session <key>] [--timeout 3000]
  node memory-client.mjs capture               --user <u> --assistant <a> [--session <key>] [--session-id <id>]
  node memory-client.mjs search-memories       --query <q> [--limit 5] [--type <t>] [--scene <s>]
  node memory-client.mjs search-conversations  --query <q> [--limit 5] [--session <key>]
  node memory-client.mjs health

公共选项:
  --base-url <url>   默认 http://127.0.0.1:8420 (env: TDAI_GATEWAY_BASE_URL)
  --api-key  <key>   可选 Bearer        (env: TDAI_GATEWAY_API_KEY)
  --session  <key>   覆盖 session_key   (默认读 .session-scope，再降级 codebuddy:global)
  --timeout  <ms>    请求超时
  --json             输出原始 JSON
`,
  );
}

// ----------------------------------------------------------------------------
// 入口
// ----------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const args = parseArgs(argv.slice(1));

  switch (sub) {
    case "recall":
      return await cmdRecall(args);
    case "capture":
      return await cmdCapture(args);
    case "search-memories":
      return await cmdSearchMemories(args);
    case "search-conversations":
      return await cmdSearchConversations(args);
    case "health":
      return await cmdHealth(args);
    case "-h":
    case "--help":
    case undefined:
      usage();
      return sub === undefined ? 1 : 0;
    default:
      process.stderr.write(`[memory-client] 未知子命令: ${sub}\n`);
      usage();
      return 2;
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    // 兜底：任何未捕获异常都不应抛堆栈到 stdout
    process.stderr.write(`[memory-client] fatal: ${errMsg(err)}\n`);
    process.exit(1);
  });
