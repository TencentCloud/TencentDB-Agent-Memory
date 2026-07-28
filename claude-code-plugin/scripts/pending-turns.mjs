import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_PROMPT_CHARS = 1_000_000;
const STATE_TTL_MS = 24 * 60 * 60 * 1_000;

export async function rememberPrompt({ sessionId, promptId, prompt }) {
  const directory = await ensureStateDirectory();
  await cleanupExpiredState(directory);

  const stateId = promptId
    ? hash(promptId)
    : `${String(Date.now()).padStart(13, "0")}-${randomBytes(8).toString("hex")}`;
  const finalPath = statePath(directory, sessionId, stateId, ".json");
  const temporaryPath = `${finalPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const record = {
    schema: 1,
    session_hash: hash(sessionId),
    prompt_hash: promptId ? hash(promptId) : null,
    prompt: String(prompt).slice(0, MAX_PROMPT_CHARS),
    created_at: Date.now()
  };

  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(record), "utf8");
  } finally {
    await handle.close();
  }
  await replaceFile(temporaryPath, finalPath);
}

export async function claimPrompt({ sessionId, promptId }) {
  const directory = await ensureStateDirectory();
  let sourcePath;

  if (promptId) {
    sourcePath = statePath(directory, sessionId, hash(promptId), ".json");
  } else {
    // Current documented hook payloads do not include a prompt ID, and Claude
    // warns that transcript writes may lag. Stop command processes are spawned
    // immediately, so the newest submitted prompt is the least ambiguous
    // correlation and skips stale records from interrupted/failed model turns.
    sourcePath = await newestPendingPath(directory, sessionId);
    if (!sourcePath) return null;
  }

  const claimedPath = sourcePath.replace(/\.json$/, ".inflight");
  try {
    await rename(sourcePath, claimedPath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EEXIST") return null;
    throw error;
  }

  try {
    const record = JSON.parse(await readFile(claimedPath, "utf8"));
    if (
      record?.schema !== 1 ||
      record?.session_hash !== hash(sessionId) ||
      typeof record?.prompt !== "string"
    ) {
      await safeUnlink(claimedPath);
      return null;
    }
    return {
      prompt: record.prompt,
      path: claimedPath
    };
  } catch (error) {
    await safeUnlink(claimedPath);
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function completeClaim(claim) {
  if (claim?.path) await safeUnlink(claim.path);
}

export async function abandonClaim(claim) {
  if (!claim?.path) return;
  const failedPath = claim.path.replace(/\.inflight$/, ".failed");
  try {
    await replaceFile(claim.path, failedPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function waitForSessionIdle(sessionId, waitMs) {
  const directory = await ensureStateDirectory();
  const deadline = Date.now() + waitMs;
  do {
    if (!(await hasSessionState(directory, sessionId))) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return !(await hasSessionState(directory, sessionId));
}

export async function takeChangedStableContext(sessionId, context) {
  if (!context) return "";
  const directory = await ensurePluginStateDirectory("stable-context");
  const finalPath = path.join(directory, `${hash(sessionId)}.json`);
  const contextHash = hash(context);

  try {
    const previous = JSON.parse(await readFile(finalPath, "utf8"));
    if (previous?.schema === 1 && previous?.context_hash === contextHash) {
      return "";
    }
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }

  const temporaryPath = `${finalPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(
      JSON.stringify({
        schema: 1,
        context_hash: contextHash,
        updated_at: Date.now()
      }),
      "utf8"
    );
  } finally {
    await handle.close();
  }
  await replaceFile(temporaryPath, finalPath);
  return context;
}

export async function clearStableContext(sessionId) {
  const directory = await ensurePluginStateDirectory("stable-context");
  await safeUnlink(path.join(directory, `${hash(sessionId)}.json`));
}

async function ensureStateDirectory() {
  return ensurePluginStateDirectory("pending-turns");
}

async function ensurePluginStateDirectory(name) {
  const pluginData = process.env.CLAUDE_PLUGIN_DATA?.trim();
  const fallbackIdentity =
    typeof process.getuid === "function" ? String(process.getuid()) : "user";
  const root = pluginData || path.join(
    os.tmpdir(),
    "tencentdb-agent-memory-claude",
    fallbackIdentity
  );
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function statePath(directory, sessionId, stateId, extension) {
  const sessionHash = hash(sessionId);
  return path.join(directory, `${sessionHash}-${stateId}${extension}`);
}

async function newestPendingPath(directory, sessionId) {
  const prefix = `${hash(sessionId)}-`;
  const entries = await readdir(directory, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(".json")) {
      continue;
    }
    const candidate = path.join(directory, entry.name);
    try {
      const modified = (await stat(candidate)).mtimeMs;
      candidates.push({ path: candidate, modified });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  candidates.sort(
    (left, right) => right.modified - left.modified || right.path.localeCompare(left.path)
  );
  return candidates[0]?.path ?? null;
}

async function hasSessionState(directory, sessionId) {
  const prefix = `${hash(sessionId)}-`;
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.some(
    (entry) =>
      entry.isFile() &&
      entry.name.startsWith(prefix) &&
      (entry.name.endsWith(".json") || entry.name.endsWith(".inflight"))
  );
}

async function cleanupExpiredState(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const now = Date.now();
  await Promise.all(
    entries.slice(0, 500).map(async (entry) => {
      if (
        !entry.isFile() ||
        ![".json", ".inflight", ".failed", ".tmp"].some((suffix) =>
          entry.name.endsWith(suffix)
        )
      ) {
        return;
      }
      const candidate = path.join(directory, entry.name);
      try {
        const info = await stat(candidate);
        if (now - info.mtimeMs > STATE_TTL_MS) await safeUnlink(candidate);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    })
  );
}

async function safeUnlink(candidate) {
  try {
    await unlink(candidate);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function replaceFile(source, destination) {
  try {
    await rename(source, destination);
  } catch (error) {
    // POSIX rename replaces an existing destination; Windows does not. A
    // repeated hook event for the same prompt ID should replace its pending
    // record consistently on both platforms.
    if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
    await safeUnlink(destination);
    await rename(source, destination);
  }
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}
