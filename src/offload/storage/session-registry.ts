/**
 * Session registry + StorageContext builder (split from storage.ts).
 * `registerSession` / `lookupSessionId` / `listRegisteredSessions` maintain
 * sessionKey → realSessionId mapping in `<dataDir>/sessions-registry.json`.
 * `createStorageContext` / `parseSessionKey` / `ensureDirs` are part of the
 * storage init layer (no global mutable state — `StorageContext` is frozen).
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { StorageContext } from "../storage-shim-types.js";

/** Sanitize a string for use as a directory/file name */
function sanitizePath(s: string): string {
  return s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\.{2,}/g, "_");
}

/**
 * Parse a sessionKey into agentName and sessionId.
 * Expected format: "agent:<agent-name>:<session-id>"
 * Worker isolation: if the sessionId contains a "swebench-w{N}" pattern,
 * the worker suffix is merged into agentName.
 * Returns null if format doesn't match.
 */
export function parseSessionKey(
  sessionKey: string,
): { agentName: string; sessionId: string } | null {
  if (typeof sessionKey !== "string") return null;
  const parts = sessionKey.split(":");
  if (parts.length < 3 || parts[0] !== "agent" || !parts[1]) return null;
  let agentName = parts[1];
  const sessionId = parts.slice(2).join(":");
  if (!sessionId) return null;
  const workerMatch = sessionId.match(/swebench-w(\d+)/);
  if (workerMatch) {
    agentName = `${agentName}-w${workerMatch[1]}`;
  }
  return {
    agentName: sanitizePath(agentName),
    sessionId: sanitizePath(sessionId),
  };
}

/** Build an immutable StorageContext for a given agent + session. */
export function createStorageContext(
  dataRoot: string,
  agentName: string,
  sessionId: string,
): StorageContext {
  const dataDir = join(dataRoot, agentName);
  return Object.freeze({
    dataRoot,
    dataDir,
    refsDir: join(dataDir, "refs"),
    mmdsDir: join(dataDir, "mmds"),
    offloadJsonl: join(dataDir, `offload-${sessionId}.jsonl`),
    stateFile: join(dataDir, "state.json"),
    agentName,
    sessionId,
  });
}

/** Ensure all required directories exist for the given context */
export async function ensureDirs(ctx: StorageContext): Promise<void> {
  await mkdir(ctx.dataRoot, { recursive: true });
  await mkdir(ctx.dataDir, { recursive: true });
  await mkdir(ctx.refsDir, { recursive: true });
  await mkdir(ctx.mmdsDir, { recursive: true });
}

/** Record a sessionKey → realSessionId mapping in the agent's registry. */
export async function registerSession(
  ctx: StorageContext,
  sessionKey: string,
  realSessionId: string,
): Promise<void> {
  if (!sessionKey || !realSessionId || !existsSync(ctx.dataDir)) return;
  const registryPath = join(ctx.dataDir, "sessions-registry.json");
  let registry: Record<string, unknown> = {};
  try {
    if (existsSync(registryPath)) {
      registry = JSON.parse(await readFile(registryPath, "utf-8"));
    }
  } catch {
    /* corrupt file, start fresh */
  }
  registry[sessionKey] = {
    sessionId: realSessionId,
    offloadFile: `offload-${realSessionId}.jsonl`,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(registryPath, JSON.stringify(registry, null, 2), "utf-8");
}

/** Look up the real sessionId for a given sessionKey from the registry. */
export async function lookupSessionId(
  ctx: StorageContext,
  sessionKey: string,
): Promise<string | null> {
  if (!sessionKey || !existsSync(ctx.dataDir)) return null;
  const registryPath = join(ctx.dataDir, "sessions-registry.json");
  try {
    if (!existsSync(registryPath)) return null;
    const registry = JSON.parse(await readFile(registryPath, "utf-8")) as Record<string, { sessionId?: string }>;
    return registry[sessionKey]?.sessionId ?? null;
  } catch {
    return null;
  }
}

/** List all registered sessions for the given context. */
export async function listRegisteredSessions(
  ctx: StorageContext,
): Promise<Array<{ sessionKey: string; [key: string]: unknown }>> {
  if (!existsSync(ctx.dataDir)) return [];
  const registryPath = join(ctx.dataDir, "sessions-registry.json");
  try {
    if (!existsSync(registryPath)) return [];
    const registry = JSON.parse(await readFile(registryPath, "utf-8")) as Record<string, Record<string, unknown>>;
    return Object.entries(registry).map(([key, val]) => ({
      sessionKey: key,
      ...val,
    }));
  } catch {
    return [];
  }
}
