/**
 * Client Identity Extraction — extracts user ID, session ID, and other
 * identifiers from intercepted CodeBuddy requests.
 *
 * CodeBuddy sends requests to this proxy with:
 * 1. Authorization header: `Bearer ck_<user_token>.<secret>` — API key
 * 2. Various HTTP headers that may contain user/session metadata
 * 3. System prompt content with `<user_info>` that embeds workspace info
 *
 * This module:
 * - Extracts all available identity signals from headers and body
 * - Maintains a ring buffer of recent inspections for debugging
 * - Provides a stable `userId` derived from the API key structure
 */

import { createHash } from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ClientIdentity {
  /** Derived user ID from API key prefix (e.g. "ck_fovj16r9s5j4") */
  userId: string | null;
  /** Full API key hash (first 8 hex chars of SHA-256) */
  keyId: string;
  /** Raw API key prefix (everything before the first dot) — user-level token */
  apiKeyPrefix: string | null;
  /** Session/conversation ID if found in headers or body */
  sessionId: string | null;
  /** Enterprise WeChat (企微) ID if found in headers */
  wechatWorkId: string | null;
  /** Any x-request-id or trace ID from headers */
  requestId: string | null;
  /** User-Agent header value */
  userAgent: string | null;
  /** All custom x- headers (for discovery) */
  customHeaders: Record<string, string>;
  /** Extracted from system prompt <user_info> if present */
  userInfo: UserInfoFromPrompt | null;
  /** Agent source name from URL path (e.g. "codebuddy", "claude-code"). */
  agentSource: string;
  /** Proxy-issued user token from `X-Tdai-User-Token` header (panel-generated). */
  proxyToken: string | null;
}

export interface UserInfoFromPrompt {
  /** OS Version extracted from prompt */
  osVersion: string | null;
  /** Shell type */
  shell: string | null;
  /** Workspace folder path */
  workspaceFolder: string | null;
  /** Username extracted from workspace path (e.g. /data/home/demo-user → demo-user) */
  usernameFromPath: string | null;
  /** Current time if present */
  currentTime: string | null;
  /** Any session/conversation ID found in the prompt content */
  sessionIdFromPrompt: string | null;
  /** Plan ID if present in additional_data */
  planId: string | null;
}

export interface RequestInspection {
  timestamp: string;
  method: string;
  path: string;
  identity: ClientIdentity;
  allHeaders: Record<string, string>;
  bodyMeta: {
    model: string | null;
    messageCount: number;
    stream: boolean;
    hasTools: boolean;
    hasSystemPrompt: boolean;
    systemPromptLength: number;
    systemContentType?: string;
    systemPromptPreview?: string;
    systemPromptTail?: string;
  };
}

// ── Ring buffer for recent inspections ─────────────────────────────────────────

const MAX_INSPECTIONS = 20;
const recentInspections: RequestInspection[] = [];

export function recordInspection(inspection: RequestInspection): void {
  recentInspections.push(inspection);
  if (recentInspections.length > MAX_INSPECTIONS) {
    recentInspections.shift();
  }
}

export function getRecentInspections(): RequestInspection[] {
  return [...recentInspections];
}

// ── Identity extraction from headers ───────────────────────────────────────────

/**
 * Extract client identity from request headers.
 *
 * CodeBuddy API key format: `ck_<user_token>.<secret_key>`
 * The prefix before the dot is a user-level identifier.
 */
export function extractClientIdentity(
  headers: Record<string, string>,
  body?: Record<string, unknown>,
  agentSource = "claude-code",
): ClientIdentity {
  // Extract API key — prefer the auth-decoupling header (x-mem-user-key) when
  // present, because `passthroughClientAuth` mode puts the user_key (sk-mem-*)
  // there and leaves Authorization for the corporate gateway key. The user_key
  // carries the client-type prefix (ck_ / sk-mem- / sk-ant-) used below for
  // identity detection; the corporate key does not.
  const userKeyHeaderVal = headers["x-mem-user-key"] ?? headers["X-Mem-User-Key"] ?? "";
  const authHeader = headers["authorization"] ?? headers["Authorization"] ?? "";
  const apiKey = userKeyHeaderVal || extractBearer(authHeader);

  // Parse API key structure: prefix.secret
  let apiKeyPrefix: string | null = null;
  let userId: string | null = null;
  if (apiKey) {
    const dotIndex = apiKey.indexOf(".");
    if (dotIndex > 0) {
      apiKeyPrefix = apiKey.slice(0, dotIndex);
      // The prefix IS the user-level identifier (e.g. "ck_fovj16r9s5j4")
      userId = apiKeyPrefix;
    }
  }

  const keyId = apiKey
    ? createHash("sha256").update(apiKey).digest("hex").slice(0, 8)
    : "unknown";

  // Look for session/conversation ID in common header patterns
  let sessionId: string | null =
    headers["x-session-id"] ??
    headers["x-conversation-id"] ??
    headers["x-chat-id"] ??
    headers["x-thread-id"] ??
    headers["x-cb-session-id"] ??
    headers["x-codebuddy-session-id"] ??
    headers["x-request-session"] ??
    null;

  // Enterprise WeChat ID
  let wechatWorkId: string | null =
    headers["x-wechat-work-id"] ??
    headers["x-wecom-id"] ??
    headers["x-user-id"] ??
    headers["x-cb-user-id"] ??
    headers["x-codebuddy-user-id"] ??
    null;

  // Request trace ID
  const requestId =
    headers["x-request-id"] ??
    headers["x-trace-id"] ??
    headers["x-correlation-id"] ??
    headers["traceparent"] ??
    null;

  // User-Agent
  const userAgent = headers["user-agent"] ?? null;

  // Proxy-issued user token (panel-generated). Header is case-insensitive;
  // Hono normalizes header names to lowercase, but accept both for safety.
  const proxyToken =
    headers["x-tdai-user-token"] ??
    headers["X-Tdai-User-Token"] ??
    null;

  // Collect ALL custom x- headers for discovery
  const customHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower.startsWith("x-") || lower.startsWith("cb-") || lower.startsWith("codebuddy-")) {
      customHeaders[k] = v;
    }
  }

  // Extract user info from system prompt
  let userInfo: UserInfoFromPrompt | null = null;
  if (body) {
    userInfo = extractUserInfoFromBody(body);
  }

  // If session ID wasn't found in headers, check if prompt has one
  if (!sessionId && userInfo?.sessionIdFromPrompt) {
    sessionId = userInfo.sessionIdFromPrompt;
  }

  // If wechat/work ID wasn't found in headers, try username from workspace path
  if (!wechatWorkId && userInfo?.usernameFromPath) {
    wechatWorkId = userInfo.usernameFromPath;
  }

  return {
    userId,
    keyId,
    apiKeyPrefix,
    sessionId,
    wechatWorkId,
    requestId,
    userAgent,
    customHeaders,
    userInfo,
    agentSource,
    proxyToken,
  };
}

// ── Extract user info from body/system prompt ──────────────────────────────────

/**
 * Extract identity information from the request body.
 *
 * CodeBuddy injects `<user_info>` blocks into the system prompt with:
 * - OS Version
 * - Shell type
 * - Workspace Folder path (contains username)
 * - Current time
 *
 * Also, the system prompt may contain `<additional_data>` with more context.
 */
function extractUserInfoFromBody(body: Record<string, unknown>): UserInfoFromPrompt | null {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;

  // Get system prompt content
  const systemMsg = messages.find(
    (m: unknown) => (m as Record<string, unknown>).role === "system",
  ) as Record<string, unknown> | undefined;

  if (!systemMsg) return null;

  let systemContent = "";
  if (typeof systemMsg.content === "string") {
    systemContent = systemMsg.content;
  } else if (Array.isArray(systemMsg.content)) {
    systemContent = (systemMsg.content as Array<{ type?: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  }

  if (!systemContent) return null;

  // Extract from <user_info> block
  const userInfoMatch = systemContent.match(/<user_info>([\s\S]*?)<\/user_info>/);
  let osVersion: string | null = null;
  let shell: string | null = null;
  let workspaceFolder: string | null = null;
  let currentTime: string | null = null;

  if (userInfoMatch) {
    const userInfoText = userInfoMatch[1];

    // Parse individual fields
    osVersion = extractField(userInfoText, /OS Version:\s*(.+)/i);
    shell = extractField(userInfoText, /Shell:\s*(.+)/i);
    workspaceFolder = extractField(userInfoText, /Workspace Folder:\s*(.+)/i);
    currentTime = extractField(userInfoText, /(?:current_time|Note):\s*(.+)/i);
  }

  // Extract username from workspace path (e.g. /data/home/user/... → demo-user)
  let usernameFromPath: string | null = null;
  if (workspaceFolder) {
    // Common patterns: /data/home/<user>/, /home/<user>/, /Users/<user>/
    const pathMatch = workspaceFolder.match(/\/(?:data\/)?home\/([^/]+)/i) ??
      workspaceFolder.match(/\/Users\/([^/]+)/i);
    if (pathMatch) {
      usernameFromPath = pathMatch[1];
    }
  }

  // Try to find session/conversation ID in the prompt content
  // CodeBuddy may inject session IDs in <additional_data> or other metadata blocks
  let sessionIdFromPrompt: string | null = null;
  const sessionPatterns = [
    /session[_\s-]?id["\s:=]+([^\s\n"']+)/i,
    /conversation[_\s-]?id["\s:=]+([^\s\n"']+)/i,
    /chat[_\s-]?id["\s:=]+([^\s\n"']+)/i,
    /"sessionId"\s*:\s*"([^"]+)"/i,
    /"conversationId"\s*:\s*"([^"]+)"/i,
    /uuid[:=]\s*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i,
    /session_key["\s:=]+([^\s\n"']+)/i,
  ];
  for (const pattern of sessionPatterns) {
    const match = systemContent.match(pattern);
    if (match) {
      sessionIdFromPrompt = match[1];
      break;
    }
  }

  // Try to find plan ID from <additional_data>
  let planId: string | null = null;
  const planMatch = systemContent.match(/plan[s]?\/([a-f0-9-]+)\/plan\.md/i);
  if (planMatch) {
    planId = planMatch[1];
  }

  return {
    osVersion,
    shell,
    workspaceFolder,
    usernameFromPath,
    currentTime,
    sessionIdFromPrompt,
    planId,
  };
}

function extractField(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern);
  return match ? match[1].trim() : null;
}

function extractBearer(authHeader: string): string {
  if (!authHeader) return "";
  const match = authHeader.match(/^[Bb]earer\s+(.+)$/);
  return match ? match[1].trim() : "";
}

// ── Full inspection helper (called from handler) ───────────────────────────────

/**
 * Perform a full inspection of the incoming request and record it.
 * Called from handler.ts and anthropicHandler.ts.
 */
export function inspectAndRecord(
  method: string,
  path: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  agentSource = "claude-code",
): ClientIdentity {
  const identity = extractClientIdentity(headers, body, agentSource);

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemMsg = messages.find(
    (m: unknown) => (m as Record<string, unknown>).role === "system",
  ) as Record<string, unknown> | undefined;

  // Anthropic 协议的 system prompt 在 body.system 字段（不在 messages 中）
  // Claude Code 走 Anthropic 协议，system prompt 是 body.system
  const anthropicSystem = body.system;
  let anthropicSystemText: string | null = null;
  if (typeof anthropicSystem === "string") {
    anthropicSystemText = anthropicSystem;
  } else if (Array.isArray(anthropicSystem)) {
    anthropicSystemText = (anthropicSystem as Array<{ type?: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  }

  let systemPromptLength = 0;
  if (systemMsg) {
    if (typeof systemMsg.content === "string") {
      systemPromptLength = systemMsg.content.length;
    } else if (Array.isArray(systemMsg.content)) {
      systemPromptLength = JSON.stringify(systemMsg.content).length;
    }
  } else if (anthropicSystemText) {
    systemPromptLength = anthropicSystemText.length;
  }

  // Extract system prompt preview (first 5000 chars) for debugging
  let systemPromptPreview: string | null = null;
  let systemPromptTail: string | null = null;
  let systemContentType: string | null = null;

  // 优先用 OpenAI 格式的 system message
  if (systemMsg) {
    if (typeof systemMsg.content === "string") {
      systemContentType = "string";
      systemPromptPreview = systemMsg.content.slice(0, 5000);
      if (systemMsg.content.length > 5000) {
        systemPromptTail = systemMsg.content.slice(-3000);
      }
    } else if (Array.isArray(systemMsg.content)) {
      systemContentType = "array";
      const textBlocks = (systemMsg.content as Array<{ type?: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      systemPromptPreview = textBlocks.slice(0, 5000);
      if (textBlocks.length > 5000) {
        systemPromptTail = textBlocks.slice(-3000);
      }
    }
  } else if (anthropicSystemText) {
    // Anthropic 格式的 system prompt（Claude Code 走这里）
    systemContentType = typeof anthropicSystem === "string" ? "anthropic-string" : "anthropic-array";
    systemPromptPreview = anthropicSystemText.slice(0, 5000);
    if (anthropicSystemText.length > 5000) {
      systemPromptTail = anthropicSystemText.slice(-3000);
    }
  }

  // Sanitize sensitive headers before logging — x-mem-user-key and
  // authorization carry user_key / corporate gateway key material that
  // must never land in inspection logs verbatim.
  const sanitizedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === "x-mem-user-key" || lk === "authorization" || lk === "x-api-key") {
      sanitizedHeaders[k] = v ? `${v.slice(0, 8)}***` : v;
    } else {
      sanitizedHeaders[k] = v;
    }
  }

  const inspection: RequestInspection = {
    timestamp: new Date().toISOString(),
    method,
    path,
    identity,
    allHeaders: sanitizedHeaders,
    bodyMeta: {
      model: typeof body.model === "string" ? body.model : null,
      messageCount: messages.length,
      stream: body.stream === true,
      hasTools: Array.isArray(body.tools) && body.tools.length > 0,
      hasSystemPrompt: !!systemMsg || !!anthropicSystemText,
      systemPromptLength,
      systemContentType: systemContentType as string | undefined,
      systemPromptPreview: systemPromptPreview as string | undefined,
      systemPromptTail: systemPromptTail as string | undefined,
    },
  };

  recordInspection(inspection);

  // Also log to stderr for real-time visibility
  console.error(
    `[identity] userId=${identity.userId ?? "?"} keyId=${identity.keyId} ` +
    `sessionId=${identity.sessionId ?? "none"} ` +
    `wechatId=${identity.wechatWorkId ?? "none"} ` +
    `user=${identity.userInfo?.usernameFromPath ?? "?"} ` +
    `ws=${identity.userInfo?.workspaceFolder ?? "?"} ` +
    `proxyToken=${identity.proxyToken ? identity.proxyToken.slice(0, 12) + "***" : "none"}` +
    (Object.keys(identity.customHeaders).length > 0
      ? ` custom=[${Object.keys(identity.customHeaders).join(",")}]`
      : ""),
  );

  // [DEBUG-CC-SESSION] 临时调试：打印 Claude Code SDK 注入的 session id 值，
  // 用于验证「同一次 claude 启动多次请求同 id / 不同启动不同 id」。验证完即移除。
  {
    const ccSid =
      identity.customHeaders["x-claude-code-session-id"] ??
      identity.customHeaders["X-Claude-Code-Session-Id"];
    const xApp =
      identity.customHeaders["x-app"] ?? identity.customHeaders["X-App"];
    if (ccSid || xApp) {
      console.error(
        `[debug-cc] x-claude-code-session-id=${ccSid ?? "none"} x-app=${xApp ?? "none"}`,
      );
    }
  }

  return identity;
}
