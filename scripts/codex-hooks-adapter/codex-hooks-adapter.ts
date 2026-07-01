#!/usr/bin/env node
/**
 * Codex hook adapter for memory-tencentdb.
 *
 * Codex exposes lifecycle hooks over stdin/stdout JSON. This adapter maps the
 * documented UserPromptSubmit and Stop hook events to the shared Adapter SDK so
 * Codex can use the same Gateway-backed memory integration as MCP/Hermes.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  asRecord,
  GatewayMemoryOperations,
  optionalString,
  TdaiAdapterRuntime,
  TdaiGatewayClient,
} from "../../src/adapter-sdk/index.js";
import type {
  AdapterEventEnvelope,
  AdapterRecallResult,
  TdaiPlatformAdapter,
} from "../../src/adapter-sdk/index.js";

const DEFAULT_GATEWAY_HOST = "127.0.0.1";
const DEFAULT_GATEWAY_PORT = 8420;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_SESSION_PREFIX = "codex";
const DEFAULT_STATE_DIR = path.join(os.homedir(), ".memory-tencentdb", "codex-hooks");

type CodexHookEventName = "UserPromptSubmit" | "Stop" | string;

export interface CodexHookInput {
  session_id?: string;
  turn_id?: string;
  cwd?: string;
  hook_event_name?: CodexHookEventName;
  prompt?: string;
  last_assistant_message?: string | null;
}

export interface CodexHookContext {
  sessionKey: string;
  sessionId?: string;
  userId?: string;
}

export interface CodexHookOutput {
  continue?: boolean;
  systemMessage?: string;
  hookSpecificOutput?: {
    additionalContext?: string;
  };
}

export interface CodexAdapterConfig {
  gatewayUrl: string;
  apiKey?: string;
  timeoutMs: number;
  sessionPrefix: string;
  fixedSessionKey?: string;
  userId?: string;
  stateDir: string;
}

export interface StoredTurn {
  userContent: string;
  sessionKey: string;
  sessionId?: string;
  userId?: string;
  startedAt: number;
}

function readConfigFromEnv(): CodexAdapterConfig {
  const explicitUrl = process.env.MEMORY_TENCENTDB_GATEWAY_URL?.trim();
  const host = process.env.MEMORY_TENCENTDB_GATEWAY_HOST?.trim() || DEFAULT_GATEWAY_HOST;
  const port = parseIntegerEnv("MEMORY_TENCENTDB_GATEWAY_PORT", DEFAULT_GATEWAY_PORT);
  const timeoutMs = parseIntegerEnv("MEMORY_TENCENTDB_CODEX_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);

  return {
    gatewayUrl: explicitUrl || `http://${host}:${port}`,
    apiKey:
      process.env.MEMORY_TENCENTDB_GATEWAY_API_KEY?.trim() ||
      process.env.TDAI_GATEWAY_API_KEY?.trim() ||
      undefined,
    timeoutMs,
    sessionPrefix: process.env.MEMORY_TENCENTDB_CODEX_SESSION_PREFIX?.trim() || DEFAULT_SESSION_PREFIX,
    fixedSessionKey: process.env.MEMORY_TENCENTDB_CODEX_SESSION_KEY?.trim() || undefined,
    userId: process.env.MEMORY_TENCENTDB_CODEX_USER_ID?.trim() || undefined,
    stateDir: process.env.MEMORY_TENCENTDB_CODEX_STATE_DIR?.trim() || DEFAULT_STATE_DIR,
  };
}

function parseIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function createRuntime(config: CodexAdapterConfig): TdaiAdapterRuntime<CodexHookInput, CodexHookContext> {
  const client = new TdaiGatewayClient({
    baseUrl: config.gatewayUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
  });

  return new TdaiAdapterRuntime({
    adapter: createCodexPlatformAdapter(),
    operations: new GatewayMemoryOperations({
      client,
      defaultSessionKey: config.fixedSessionKey || `${config.sessionPrefix}:default`,
    }),
  });
}

export function createCodexPlatformAdapter(): TdaiPlatformAdapter<CodexHookInput, CodexHookContext> {
  return {
    platform: "codex-hooks",

    getSession({ context }) {
      return {
        sessionKey: context.sessionKey,
        sessionId: context.sessionId,
        userId: context.userId,
      };
    },

    getRecallInput({ event }) {
      if (event.hook_event_name !== "UserPromptSubmit" || !event.prompt?.trim()) return undefined;
      return { query: event.prompt };
    },

    getCaptureInput({ event, context }) {
      if (event.hook_event_name !== "Stop" || !event.last_assistant_message?.trim()) return undefined;
      return {
        userContent: event.prompt ?? "",
        assistantContent: event.last_assistant_message,
        originalUserMessageCount: 1,
        messages: [],
      };
    },

    applyRecallResult(result) {
      return formatRecallAdditionalContext(result);
    },
  };
}

export function formatRecallAdditionalContext(result: AdapterRecallResult): string {
  const sections: string[] = [];
  if (result.prependContext?.trim()) sections.push(result.prependContext.trim());
  if (result.appendSystemContext?.trim()) sections.push(result.appendSystemContext.trim());
  if (sections.length === 0) return "";

  return [
    "TencentDB Agent Memory recalled context for this Codex turn:",
    ...sections,
  ].join("\n\n");
}

export function buildContext(input: CodexHookInput, config: CodexAdapterConfig): CodexHookContext {
  const fallbackSessionId = sanitizeKey(input.session_id || "default");
  const sessionKey = config.fixedSessionKey || `${config.sessionPrefix}:${fallbackSessionId}`;
  return {
    sessionKey,
    sessionId: input.turn_id || input.session_id,
    userId: config.userId,
  };
}

export async function handleUserPromptSubmit(
  runtime: TdaiAdapterRuntime<CodexHookInput, CodexHookContext>,
  input: CodexHookInput,
  context: CodexHookContext,
  config: CodexAdapterConfig,
): Promise<CodexHookOutput> {
  const prompt = input.prompt?.trim();
  if (!prompt) return {};

  await storeTurn(config.stateDir, input, context, prompt);

  const recalled = await runtime.handleRecall({ event: input, context });
  const additionalContext = typeof recalled === "string" ? recalled.trim() : "";
  if (!additionalContext) return {};

  return {
    hookSpecificOutput: {
      additionalContext,
    },
  };
}

export async function handleStop(
  runtime: TdaiAdapterRuntime<CodexHookInput, CodexHookContext>,
  input: CodexHookInput,
  context: CodexHookContext,
  config: CodexAdapterConfig,
): Promise<CodexHookOutput> {
  const assistantText = input.last_assistant_message?.trim();
  if (!assistantText) return {};

  const storedTurn = await readStoredTurn(config.stateDir, input);
  if (!storedTurn?.userContent.trim()) return {};

  const captured = await runtime.handleCapture({
    event: {
      ...input,
      prompt: storedTurn.userContent,
      last_assistant_message: assistantText,
    },
    context: {
      sessionKey: storedTurn.sessionKey || context.sessionKey,
      sessionId: storedTurn.sessionId || context.sessionId,
      userId: storedTurn.userId || context.userId,
    },
  } satisfies AdapterEventEnvelope<CodexHookInput, CodexHookContext>);

  if (captured && captured.l0RecordedCount > 0) {
    await removeStoredTurn(config.stateDir, input);
  }
  return {};
}

export async function storeTurn(
  stateDir: string,
  input: CodexHookInput,
  context: CodexHookContext,
  userContent: string,
): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const turn: StoredTurn = {
    userContent,
    sessionKey: context.sessionKey,
    sessionId: context.sessionId,
    userId: context.userId,
    startedAt: Date.now(),
  };
  await writeFile(statePath(stateDir, input), JSON.stringify(turn), "utf8");
}

export async function readStoredTurn(stateDir: string, input: CodexHookInput): Promise<StoredTurn | undefined> {
  try {
    const raw = await readFile(statePath(stateDir, input), "utf8");
    const parsed = asRecord(JSON.parse(raw));
    const userContent = optionalString(parsed, "userContent");
    const sessionKey = optionalString(parsed, "sessionKey");
    if (!userContent || !sessionKey) return undefined;
    return {
      userContent,
      sessionKey,
      sessionId: optionalString(parsed, "sessionId"),
      userId: optionalString(parsed, "userId"),
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : Date.now(),
    };
  } catch {
    return undefined;
  }
}

export async function removeStoredTurn(stateDir: string, input: CodexHookInput): Promise<void> {
  await rm(statePath(stateDir, input), { force: true });
}

function statePath(stateDir: string, input: CodexHookInput): string {
  const session = sanitizeKey(input.session_id || "default");
  const turn = sanitizeKey(input.turn_id || "latest");
  return path.join(stateDir, `${session}-${turn}.json`);
}

function sanitizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 160) || "default";
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeHookOutput(output: CodexHookOutput): void {
  if (Object.keys(output).length === 0) return;
  process.stdout.write(JSON.stringify(output));
}

export async function main(): Promise<void> {
  const rawInput = await readStdin();
  if (!rawInput.trim()) return;

  const input = JSON.parse(rawInput) as CodexHookInput;
  const config = readConfigFromEnv();
  const context = buildContext(input, config);
  const runtime = createRuntime(config);

  if (input.hook_event_name === "UserPromptSubmit") {
    writeHookOutput(await handleUserPromptSubmit(runtime, input, context, config));
    return;
  }

  if (input.hook_event_name === "Stop") {
    writeHookOutput(await handleStop(runtime, input, context, config));
  }
}

if (isMainModule()) {
  main().catch((err) => {
    process.stderr.write(`[memory-tencentdb-codex-hook] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(0);
  });
}

function isMainModule(): boolean {
  return process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;
}
