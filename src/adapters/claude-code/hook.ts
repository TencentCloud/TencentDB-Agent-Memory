#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  GatewayMemoryClient,
  type GatewayMemoryClientOptions,
  type GatewayRecallResponse,
} from "../gateway-client/index.js";

const MAX_CONTEXT_CHARS = 8_000;
const MAX_QUEUED_TURNS = 100;
const MAX_GLOBAL_STATE_BYTES = 5 * 1024 * 1024;
const MAX_RETRIES_PER_PROMPT = 1;
const PROMPT_RETRY_TIMEOUT_MS = 2_000;
const SESSION_END_OPERATION_TIMEOUT_MS = 400;

export interface ClaudeHookInput {
  session_id: string;
  cwd?: string;
  transcript_path?: string;
  hook_event_name: "UserPromptSubmit" | "Stop" | "SessionEnd" | string;
  prompt?: string;
  last_assistant_message?: string;
  reason?: string;
}

interface PendingPrompt {
  content: string;
  timestamp: number;
}

export interface QueuedClaudeTurn {
  id: string;
  userContent: string;
  assistantContent: string;
  userTimestamp: number;
  assistantTimestamp: number;
}

export interface ClaudeHookState {
  pendingPrompt?: PendingPrompt;
  queue: QueuedClaudeTurn[];
}

export interface ClaudeHookOptions {
  pluginDataDir?: string;
  client?: GatewayMemoryClient;
  now?: () => number;
  logger?: (message: string) => void;
  maxRetriesPerPrompt?: number;
  promptRetryTimeoutMs?: number;
  sessionEndOperationTimeoutMs?: number;
}

function digest(value: string, length = 24): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function deriveClaudeSessionKey(
  sessionId: string,
  override = process.env.TDAI_CLAUDE_SESSION_KEY,
): string {
  return override?.trim() || `claude:${digest(sessionId, 12)}`;
}

function stateDirectory(pluginDataDir: string): string {
  return path.join(pluginDataDir, "memory-tencentdb", "state");
}

export function stateFileForSession(pluginDataDir: string, sessionId: string): string {
  return path.join(stateDirectory(pluginDataDir), `${digest(sessionId)}.json`);
}

function parseState(value: unknown): ClaudeHookState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<ClaudeHookState>;
  if (!Array.isArray(candidate.queue)) return null;
  if (
    candidate.pendingPrompt !== undefined
    && (
      !candidate.pendingPrompt
      || typeof candidate.pendingPrompt.content !== "string"
      || !Number.isSafeInteger(candidate.pendingPrompt.timestamp)
      || candidate.pendingPrompt.timestamp < 0
    )
  ) {
    return null;
  }
  for (const turn of candidate.queue) {
    if (
      !turn
      || typeof turn !== "object"
      || typeof turn.id !== "string"
      || typeof turn.userContent !== "string"
      || typeof turn.assistantContent !== "string"
      || !Number.isSafeInteger(turn.userTimestamp)
      || turn.userTimestamp < 0
      || !Number.isSafeInteger(turn.assistantTimestamp)
      || turn.assistantTimestamp < turn.userTimestamp
    ) {
      return null;
    }
  }
  return {
    pendingPrompt: candidate.pendingPrompt,
    queue: candidate.queue,
  };
}

async function quarantineInvalidState(
  file: string,
  logger: (message: string) => void,
): Promise<void> {
  const quarantined = `${file}.corrupt-${Date.now()}-${randomUUID()}`;
  try {
    await rename(file, quarantined);
    logger(`invalid hook state quarantined as ${path.basename(quarantined)}`);
  } catch (error) {
    logger(
      `invalid hook state could not be quarantined: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function loadState(
  file: string,
  logger?: (message: string) => void,
): Promise<ClaudeHookState> {
  try {
    const parsed = parseState(JSON.parse(await readFile(file, "utf8")));
    if (parsed) return parsed;
    if (logger) {
      await quarantineInvalidState(file, logger);
      return { queue: [] };
    }
    throw new Error("invalid Claude hook state schema");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { queue: [] };
    if (error instanceof SyntaxError && logger) {
      await quarantineInvalidState(file, logger);
      return { queue: [] };
    }
    throw error;
  }
}

async function saveState(file: string, state: ClaudeHookState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let replaced = false;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, file);
    replaced = true;
  } finally {
    if (!replaced) await unlink(temporary).catch(() => {});
  }
}

async function enforceGlobalStateLimit(
  directory: string,
  currentFile: string,
  currentState: ClaudeHookState,
  logger: (message: string) => void,
): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch {
    return;
  }
  const entries = (await Promise.all(names.map(async (name) => {
    const file = path.join(directory, name);
    try {
      const state = file === currentFile ? currentState : await loadState(file);
      return { file, state };
    } catch {
      return null;
    }
  }))).filter((entry): entry is { file: string; state: ClaudeHookState } => !!entry);
  let total = entries.reduce(
    (sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry.state.queue)),
    0,
  );
  if (total <= MAX_GLOBAL_STATE_BYTES) return;

  const queued = entries
    .flatMap((entry) => entry.state.queue.map((turn) => ({ entry, turn })))
    .sort((a, b) =>
      a.turn.assistantTimestamp - b.turn.assistantTimestamp
      || a.turn.userTimestamp - b.turn.userTimestamp
      || a.turn.id.localeCompare(b.turn.id));
  const changed = new Set<{ file: string; state: ClaudeHookState }>();

  for (const { entry, turn } of queued) {
    if (total <= MAX_GLOBAL_STATE_BYTES) break;
    const index = entry.state.queue.findIndex((candidate) => candidate.id === turn.id);
    if (index < 0) continue;
    const before = Buffer.byteLength(JSON.stringify(entry.state.queue));
    entry.state.queue.splice(index, 1);
    const after = Buffer.byteLength(JSON.stringify(entry.state.queue));
    total -= before - after;
    changed.add(entry);
    logger(`global retry queue exceeded 5 MiB; dropped oldest failed turn ${turn.id}`);
  }

  for (const entry of changed) {
    await saveState(entry.file, entry.state);
  }
}

function gatewayOptionsFromEnv(timeoutMs?: number): GatewayMemoryClientOptions {
  const rawTimeout = process.env.TDAI_GATEWAY_TIMEOUT_MS?.trim();
  return {
    baseUrl: process.env.TDAI_GATEWAY_URL?.trim() || "http://127.0.0.1:8420",
    apiKey: process.env.TDAI_GATEWAY_API_KEY,
    timeoutMs: timeoutMs ?? (rawTimeout ? Number(rawTimeout) : 5_000),
    allowRemote: /^(1|true|yes)$/i.test(
      process.env.TDAI_GATEWAY_ALLOW_REMOTE?.trim() ?? "",
    ),
  };
}

function queueTurn(
  state: ClaudeHookState,
  turn: QueuedClaudeTurn,
  logger: (message: string) => void,
): void {
  if (!state.queue.some((queued) => queued.id === turn.id)) {
    state.queue.push(turn);
  }
  if (state.queue.length > MAX_QUEUED_TURNS) {
    const dropped = state.queue.length - MAX_QUEUED_TURNS;
    state.queue.splice(0, dropped);
    logger(`retry queue exceeded ${MAX_QUEUED_TURNS} turns; dropped ${dropped} oldest`);
  }
}

async function flushQueue(
  state: ClaudeHookState,
  client: GatewayMemoryClient,
  sessionKey: string,
  maxTurns: number,
): Promise<void> {
  let completed = 0;
  while (state.queue.length > 0 && completed < maxTurns) {
    const turn = state.queue[0];
    await client.capture({
      userContent: turn.userContent,
      assistantContent: turn.assistantContent,
      sessionKey,
      messages: [
        {
          role: "user",
          content: turn.userContent,
          timestamp: turn.userTimestamp,
        },
        {
          role: "assistant",
          content: turn.assistantContent,
          timestamp: turn.assistantTimestamp,
        },
      ],
    });
    state.queue.shift();
    completed += 1;
  }
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function recallText(response: GatewayRecallResponse): string {
  const dynamic = response.prepend_context?.trim();
  const stable = (response.append_system_context ?? response.context).trim();
  if (dynamic && stable && dynamic !== stable) {
    return `[Relevant memories]\n${dynamic}\n\n[Stable memory context]\n${stable}`;
  }
  return dynamic || stable;
}

function recallOutput(response: GatewayRecallResponse): Record<string, unknown> {
  const context = recallText(response);
  if (!context) return {};
  const prefix = "<memory-context>\n";
  const suffix = "\n</memory-context>";
  const bounded = context.slice(
    0,
    Math.max(0, MAX_CONTEXT_CHARS - prefix.length - suffix.length),
  );
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: `${prefix}${bounded}${suffix}`,
    },
    suppressOutput: true,
  };
}

export async function handleClaudeHook(
  input: ClaudeHookInput,
  options: ClaudeHookOptions = {},
): Promise<Record<string, unknown>> {
  const logger = options.logger ?? ((message) => process.stderr.write(
    `[memory-tencentdb-claude-hook] ${message}\n`,
  ));
  if (!input.session_id?.trim()) {
    logger("invalid hook input: session_id must be a non-empty string");
    return {};
  }
  const now = options.now ?? Date.now;
  const pluginDataDir = options.pluginDataDir
    ?? process.env.CLAUDE_PLUGIN_DATA
    ?? path.join(input.cwd || process.cwd(), ".claude", "plugin-data");
  const file = stateFileForSession(pluginDataDir, input.session_id);
  const state = await loadState(file, logger);
  const sessionKey = deriveClaudeSessionKey(input.session_id);

  if (input.hook_event_name === "UserPromptSubmit") {
    const prompt = input.prompt?.trim();
    if (!prompt) return {};

    // Persist the current prompt before constructing the transport or doing any
    // network I/O. Even an invalid Gateway configuration must not make Stop
    // lose the user side of the completed turn.
    state.pendingPrompt = { content: prompt, timestamp: now() };
    await saveState(file, state);
    await enforceGlobalStateLimit(path.dirname(file), file, state, logger);

    let client: GatewayMemoryClient;
    let retryClient: GatewayMemoryClient;
    try {
      client = options.client ?? new GatewayMemoryClient(gatewayOptionsFromEnv());
      retryClient = options.client ?? new GatewayMemoryClient(
        gatewayOptionsFromEnv(options.promptRetryTimeoutMs ?? PROMPT_RETRY_TIMEOUT_MS),
      );
    } catch (error) {
      logger(`Gateway configuration unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return {};
    }

    const retryState: ClaudeHookState = {
      pendingPrompt: state.pendingPrompt,
      queue: [...state.queue],
    };
    try {
      await withTimeout(
        flushQueue(
          retryState,
          retryClient,
          sessionKey,
          options.maxRetriesPerPrompt ?? MAX_RETRIES_PER_PROMPT,
        ),
        options.promptRetryTimeoutMs ?? PROMPT_RETRY_TIMEOUT_MS,
        "capture retry",
      );
      state.queue = retryState.queue;
      await saveState(file, state);
    } catch (error) {
      logger(`capture retry deferred: ${error instanceof Error ? error.message : String(error)}`);
    }
    await enforceGlobalStateLimit(path.dirname(file), file, state, logger);

    try {
      const recalled = await client.recall({ query: prompt, sessionKey });
      return recallOutput(recalled);
    } catch (error) {
      logger(`recall unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return {};
    }
  }

  if (input.hook_event_name === "Stop") {
    const assistant = input.last_assistant_message?.trim();
    const pending = state.pendingPrompt;
    if (!assistant || !pending) return {};
    const assistantTimestamp = now();
    const turn: QueuedClaudeTurn = {
      id: digest(
        `${input.session_id}\0${pending.timestamp}\0${pending.content}\0${assistant}`,
        32,
      ),
      userContent: pending.content,
      assistantContent: assistant,
      userTimestamp: pending.timestamp,
      assistantTimestamp,
    };
    queueTurn(state, turn, logger);
    delete state.pendingPrompt;
    await saveState(file, state);
    await enforceGlobalStateLimit(path.dirname(file), file, state, logger);

    let client: GatewayMemoryClient;
    try {
      client = options.client ?? new GatewayMemoryClient(gatewayOptionsFromEnv());
    } catch (error) {
      logger(`Gateway configuration unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return {};
    }
    try {
      await flushQueue(state, client, sessionKey, MAX_RETRIES_PER_PROMPT);
      await saveState(file, state);
    } catch (error) {
      logger(`capture queued for retry: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {};
  }

  if (input.hook_event_name === "SessionEnd") {
    const operationTimeout = options.sessionEndOperationTimeoutMs
      ?? SESSION_END_OPERATION_TIMEOUT_MS;
    let client: GatewayMemoryClient;
    try {
      client = options.client
        ?? new GatewayMemoryClient(gatewayOptionsFromEnv(operationTimeout));
    } catch (error) {
      logger(`Gateway configuration unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return {};
    }
    const retryState: ClaudeHookState = {
      pendingPrompt: state.pendingPrompt,
      queue: [...state.queue],
    };
    try {
      await withTimeout(
        flushQueue(retryState, client, sessionKey, 1),
        operationTimeout,
        "queued capture",
      );
      state.queue = retryState.queue;
      await saveState(file, state);
    } catch (error) {
      logger(`queued capture flush skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await withTimeout(
        client.endSession({ sessionKey }),
        operationTimeout,
        "session-end request",
      );
    } catch (error) {
      logger(`session-end request skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {};
  }

  return {};
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runClaudeHookCli(): Promise<void> {
  let output: Record<string, unknown> = {};
  try {
    const input = JSON.parse(await readStdin()) as ClaudeHookInput;
    output = await handleClaudeHook(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[memory-tencentdb-claude-hook] ${message}\n`);
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return !!entry && import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  runClaudeHookCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[memory-tencentdb-claude-hook] ${message}\n`);
    process.stdout.write("{}\n");
  });
}
