import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "../../utils/atomic-write.js";
import type { IMemoryStore, ProfileRecord, ProfileSyncRecord } from "../store/types.js";
import { readSceneIndex, syncSceneIndex } from "../scene/scene-index.js";
import { generateSceneNavigation, stripSceneNavigation } from "../scene/scene-navigation.js";
import type { Logger } from "../types.js";

const PROFILE_SCOPE = "global";

/** Check if an error is a rename race condition (another concurrent pull won). */
function isRenameRaceError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ENOTEMPTY" || code === "EEXIST";
}

export interface ProfileBaseline {
  version: number;
  contentMd5: string;
  createdAtMs: number;
}

export function buildProfileStableId(scope: string, type: "l2" | "l3", filename: string): string {
  const hash = createHash("sha256")
    .update(`${scope}\u0000${type}\u0000${filename}`)
    .digest("hex");
  return `profile:v1:${hash}`;
}

function md5(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

async function statTimes(filePath: string): Promise<{ createdAtMs: number; updatedAtMs: number }> {
  try {
    const stat = await fs.stat(filePath);
    return {
      createdAtMs: Math.floor(stat.birthtimeMs || stat.ctimeMs || Date.now()),
      updatedAtMs: Math.floor(stat.mtimeMs || Date.now()),
    };
  } catch {
    const now = Date.now();
    return { createdAtMs: now, updatedAtMs: now };
  }
}

async function refreshPersonaNavigation(dataDir: string): Promise<void> {
  const personaPath = path.join(dataDir, "persona.md");
  let body: string;
  try {
    body = stripSceneNavigation(await fs.readFile(personaPath, "utf-8")).trim();
  } catch {
    return;
  }

  if (!body) return;

  const index = await readSceneIndex(dataDir);
  const nav = generateSceneNavigation(index);
  const finalContent = nav ? `${body}\n\n${nav}\n` : `${body}\n`;
  await atomicWriteFile(personaPath, finalContent);
}

export async function listLocalProfiles(dataDir: string): Promise<ProfileRecord[]> {
  const profiles: ProfileRecord[] = [];
  const blocksDir = path.join(dataDir, "scene_blocks");

  try {
    const files = (await fs.readdir(blocksDir)).filter((file) => file.endsWith(".md")).sort();
    for (const filename of files) {
      const filePath = path.join(blocksDir, filename);
      const content = await fs.readFile(filePath, "utf-8");
      const { createdAtMs, updatedAtMs } = await statTimes(filePath);
      profiles.push({
        id: buildProfileStableId(PROFILE_SCOPE, "l2", filename),
        type: "l2",
        filename,
        content,
        contentMd5: md5(content),
        version: 0,
        createdAtMs,
        updatedAtMs,
      });
    }
  } catch {
    // ignore missing scene_blocks directory
  }

  const personaPath = path.join(dataDir, "persona.md");
  try {
    const rawPersona = await fs.readFile(personaPath, "utf-8");
    const body = stripSceneNavigation(rawPersona).trim();
    if (body) {
      const { createdAtMs, updatedAtMs } = await statTimes(personaPath);
      profiles.push({
        id: buildProfileStableId(PROFILE_SCOPE, "l3", "persona.md"),
        type: "l3",
        filename: "persona.md",
        content: body,
        contentMd5: md5(body),
        version: 0,
        createdAtMs,
        updatedAtMs,
      });
    }
  } catch {
    // ignore missing persona file
  }

  return profiles;
}

export async function pullProfilesToLocal(
  dataDir: string,
  store: IMemoryStore,
  logger: Logger,
): Promise<Map<string, ProfileBaseline>> {
  if (!store.pullProfiles) return new Map();

  const records = await store.pullProfiles();
  const baseline = new Map<string, ProfileBaseline>();
  const tempDir = await fs.mkdtemp(path.join(dataDir, ".profiles-pull-"));
  const tempBlocksDir = path.join(tempDir, "scene_blocks");
  await fs.mkdir(tempBlocksDir, { recursive: true });

  try {
    for (const record of records) {
      baseline.set(record.id, {
        version: record.version,
        contentMd5: record.contentMd5,
        createdAtMs: record.createdAtMs,
      });

      if (record.type === "l2") {
        const target = path.join(tempBlocksDir, record.filename);
        await fs.writeFile(target, record.content, "utf-8");
        if (md5(record.content) !== record.contentMd5) {
          await fs.rm(target, { force: true });
          logger.debug?.(`[memory-tdai][profile-sync] MD5 mismatch for ${record.filename} (will re-pull on next sync)`);
        }
        continue;
      }

      if (record.type === "l3") {
        const body = stripSceneNavigation(record.content).trim();
        await fs.writeFile(path.join(tempDir, "persona.md"), body, "utf-8");
        if (md5(body) !== record.contentMd5) {
          await fs.rm(path.join(tempDir, "persona.md"), { force: true });
          logger.debug?.(`[memory-tdai][profile-sync] MD5 mismatch for ${record.filename} (will re-pull on next sync)`);
        }
      }
    }

    const localBlocksDir = path.join(dataDir, "scene_blocks");
    await fs.rm(localBlocksDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(localBlocksDir), { recursive: true });
    try {
      await fs.rename(tempBlocksDir, localBlocksDir);
    } catch (err) {
      if (isRenameRaceError(err)) {
        // Another concurrent pull already wrote scene_blocks — ours is redundant.
        // Both pulls fetched the same remote snapshot, so the other result is equivalent.
        logger.debug?.(`[memory-tdai][profile-sync] scene_blocks rename lost race (${(err as NodeJS.ErrnoException).code}), using existing`);
        return baseline;
      }
      throw err;
    }

    const tempPersonaPath = path.join(tempDir, "persona.md");
    const localPersonaPath = path.join(dataDir, "persona.md");
    try {
      await fs.access(tempPersonaPath);
      await fs.rm(localPersonaPath, { force: true });
      try {
        await fs.rename(tempPersonaPath, localPersonaPath);
      } catch (err) {
        if (!isRenameRaceError(err)) throw err;
        logger.debug?.(`[memory-tdai][profile-sync] persona.md rename lost race, using existing`);
      }
    } catch (err) {
      // No temp persona file → remove local persona (remote has none)
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        await fs.rm(localPersonaPath, { force: true });
      } else if (!isRenameRaceError(err)) {
        throw err;
      }
    }

    await syncSceneIndex(dataDir);
    await refreshPersonaNavigation(dataDir);
    logger.debug?.(`[memory-tdai][profile-sync] Pulled ${records.length} profile(s) to local cache`);
    return baseline;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function syncLocalProfilesToStore(
  dataDir: string,
  store: IMemoryStore,
  baselineMap: Map<string, ProfileBaseline>,
  logger: Logger,
): Promise<void> {
  const localProfiles = await listLocalProfiles(dataDir);
  const localIds = new Set(localProfiles.map((profile) => profile.id));

  const syncRecords: ProfileSyncRecord[] = localProfiles
    .filter((profile) => baselineMap.get(profile.id)?.contentMd5 !== profile.contentMd5 || !baselineMap.has(profile.id))
    .map((profile) => ({
      ...profile,
      baselineVersion: baselineMap.get(profile.id)?.version,
    }));

  if (syncRecords.length > 0 && store.syncProfiles) {
    await store.syncProfiles(syncRecords);
    logger.info(`[memory-tdai][profile-sync] Synced ${syncRecords.length} changed profile(s)`);
  }

  const deletedIds = [...baselineMap.keys()].filter((id) => !localIds.has(id));
  if (deletedIds.length > 0 && store.deleteProfiles) {
    await store.deleteProfiles(deletedIds);
    logger.info(`[memory-tdai][profile-sync] Deleted ${deletedIds.length} stale profile(s)`);
  }
}

export async function ensureL2L3Local(
  dataDir: string,
  store: IMemoryStore,
  logger: Logger,
): Promise<Map<string, ProfileBaseline>> {
  if (!store.pullProfiles) return new Map();
  return pullProfilesToLocal(dataDir, store, logger);
}
