import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = 1;
const LOCK_STALE_MS = 60_000;

function digest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function requirePluginData(pluginData) {
  if (!pluginData || !path.isAbsolute(pluginData)) {
    throw new Error("PLUGIN_DATA must be an absolute directory");
  }
  return pluginData;
}

export function statePaths(pluginData, sessionKey) {
  const root = requirePluginData(pluginData);
  const id = digest(sessionKey);
  return {
    root,
    state: path.join(root, `session-${id}.json`),
    lock: path.join(root, `session-${id}.lock`),
  };
}

export function emptyState(identity) {
  return {
    schemaVersion: SCHEMA_VERSION,
    identity: {
      serviceId: identity.serviceId,
      instanceId: identity.instanceId,
      teamId: identity.teamId,
      agentId: identity.agentId,
      userId: identity.userId,
      ...(identity.taskId ? { taskId: identity.taskId } : {}),
      sessionId: identity.sessionId,
    },
    pending: null,
    lastCapturedTurnId: null,
  };
}

function sanitizeState(parsed, identity) {
  if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== SCHEMA_VERSION) {
    return emptyState(identity);
  }
  const pending = parsed.pending;
  const safePending = pending && typeof pending === "object"
    && typeof pending.turnId === "string"
    && typeof pending.prompt === "string"
    && Number.isSafeInteger(pending.promptTimestampMs)
    && pending.promptTimestampMs > 0
    ? {
        turnId: pending.turnId,
        prompt: pending.prompt,
        promptTimestampMs: pending.promptTimestampMs,
        ...(typeof pending.assistantContent === "string"
          ? { assistantContent: pending.assistantContent }
          : { assistantContent: null }),
        ...(Number.isSafeInteger(pending.assistantTimestampMs) && pending.assistantTimestampMs > 0
          ? { assistantTimestampMs: pending.assistantTimestampMs }
          : { assistantTimestampMs: null }),
      }
    : null;
  return {
    ...emptyState(identity),
    pending: safePending,
    capturePhase: ["capturing", "captured", "pending"].includes(parsed.capturePhase)
      ? parsed.capturePhase
      : undefined,
    lastCapturedTurnId: typeof parsed.lastCapturedTurnId === "string"
      ? parsed.lastCapturedTurnId
      : null,
  };
}

export async function readState(paths, identity) {
  try {
    const parsed = JSON.parse(await readFile(paths.state, "utf8"));
    return sanitizeState(parsed, identity);
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState(identity);
    throw error;
  }
}

export async function writeState(paths, state) {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const temporary = `${paths.state}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporary, paths.state);
}

export async function removeState(paths) {
  await rm(paths.state, { force: true });
}

export async function withStateLock(paths, callback) {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  let acquired = false;
  for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
    try {
      const handle = await open(paths.lock, "wx", 0o600);
      await handle.writeFile(`${Date.now()}\n`);
      await handle.close();
      acquired = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const raw = await readFile(paths.lock, "utf8");
        const created = Number(raw.trim());
        if (Number.isFinite(created) && Date.now() - created > LOCK_STALE_MS) {
          await rm(paths.lock, { force: true });
          continue;
        }
      } catch {
        // A concurrent owner may have removed the lock. Treat this invocation as
        // a no-op rather than racing the state file.
      }
      return { locked: false, value: undefined };
    }
  }
  if (!acquired) return { locked: false, value: undefined };
  try {
    return { locked: true, value: await callback() };
  } finally {
    await rm(paths.lock, { force: true });
  }
}
