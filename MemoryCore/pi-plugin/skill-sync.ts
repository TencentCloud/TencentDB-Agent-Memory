import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

const MARKER_FILE = "tdai-remote.json";
const MAX_SKILL_MD_BYTES = 1 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 5 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface RemoteSkillSummary {
  skill_id: string;
  name: string;
  version: number;
}

export interface RemoteSkillDetail extends RemoteSkillSummary {
  content: string;
  script_paths: string[];
}

export interface RemoteSkillFile {
  path: string;
  content: string;
  encoding?: "utf-8" | "base64";
}

export interface SkillSyncClient {
  list(): Promise<RemoteSkillSummary[]>;
  get(skillId: string): Promise<RemoteSkillDetail>;
  readFile(skillId: string, path: string): Promise<RemoteSkillFile>;
}

export interface SkillBridgeClientOptions {
  proxyBase: string;
  spaceId: string;
  userKey: string;
  conversationId: string;
  fetcher?: typeof fetch;
}

interface Envelope<T> {
  code: number;
  message?: string;
  error?: { message?: string };
  data?: T;
}

/**
 * Browser-free client for the already-existing, session-scoped Skill Bridge.
 * The proxy derives user/team/agent from the conversation binding, so this
 * client deliberately exposes no caller-controlled identity fields.
 */
export class SkillBridgeClient implements SkillSyncClient {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly fetcher: typeof fetch;

  constructor(options: SkillBridgeClientOptions) {
    this.base = options.proxyBase.replace(/\/$/, "");
    this.headers = {
      Authorization: `Bearer ${options.userKey}`,
      "Content-Type": "application/json",
      "x-tdai-service-id": options.spaceId,
      "x-conversation-id": options.conversationId,
    };
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async list(): Promise<RemoteSkillSummary[]> {
    const data = await this.post<{ items?: RemoteSkillSummary[] }>("list", {});
    return Array.isArray(data.items) ? data.items : [];
  }

  get(skillId: string): Promise<RemoteSkillDetail> {
    return this.post<RemoteSkillDetail>("get", { skill_id: skillId });
  }

  readFile(skillId: string, path: string): Promise<RemoteSkillFile> {
    return this.post<RemoteSkillFile>("files/read", { skill_id: skillId, path });
  }

  private async post<T>(subpath: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.fetcher(`${this.base}/skill-bridge/v3/skill/${subpath}`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let envelope: Envelope<T>;
    try {
      envelope = JSON.parse(text) as Envelope<T>;
    } catch {
      throw new Error(`skill bridge ${subpath} returned non-JSON HTTP ${response.status}`);
    }
    if (!response.ok || envelope.code !== 0 || envelope.data === undefined) {
      throw new Error(
        envelope.error?.message ?? envelope.message ?? `skill bridge ${subpath} failed (HTTP ${response.status})`,
      );
    }
    return envelope.data;
  }
}

export interface SkillSyncSource {
  proxyBase: string;
  spaceId: string;
}

export type SkillSyncStatus =
  | "synced"
  | "up-to-date"
  | "skipped-user-owned"
  | "skipped-remote-conflict"
  | "failed";

export interface SkillSyncResult {
  skillId: string;
  name: string;
  version: number;
  status: SkillSyncStatus;
  error?: string;
}

interface SyncMarker {
  adapter: "tdai-memory";
  skillId: string;
  version: number;
  skillMdSha256: string;
  source: SkillSyncSource;
  syncedAt: string;
}

function safeResourcePath(path: string): string | undefined {
  if (!path || path.includes("\0")) return undefined;
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return undefined;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return undefined;
  if (normalized === "SKILL.md" || normalized === MARKER_FILE) return undefined;
  return normalized;
}

function safeSkillName(content: string): string | undefined {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return undefined;
  const line = match[1].match(/^name:\s*["']?([^\r\n"']+)["']?\s*$/m);
  const name = line?.[1]?.trim();
  return name && SKILL_NAME_RE.test(name) ? name : undefined;
}

function byteLength(content: string, encoding: "utf-8" | "base64" | undefined): number {
  return encoding === "base64" ? Buffer.from(content, "base64").byteLength : Buffer.byteLength(content, "utf8");
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

async function readMarker(path: string): Promise<SyncMarker | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<SyncMarker>;
    if (
      parsed.adapter === "tdai-memory" &&
      typeof parsed.skillId === "string" &&
      typeof parsed.version === "number" &&
      typeof parsed.skillMdSha256 === "string"
    ) {
      return parsed as SyncMarker;
    }
  } catch {
    // Missing or malformed marker means this directory is user-owned.
  }
  return undefined;
}

async function writeFileWithin(root: string, relativePath: string, content: string | Buffer): Promise<void> {
  const destination = resolve(root, relativePath);
  if (relative(root, destination).startsWith("..")) throw new Error(`unsafe staging path: ${relativePath}`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content, { mode: 0o644 });
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  const retries = process.platform === "win32" ? 4 : 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= retries || (code !== "EPERM" && code !== "EBUSY")) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

function markerFor(detail: RemoteSkillDetail, source: SkillSyncSource): SyncMarker {
  return {
    adapter: "tdai-memory",
    skillId: detail.skill_id,
    version: detail.version,
    skillMdSha256: createHash("sha256").update(detail.content, "utf8").digest("hex"),
    source,
    syncedAt: new Date().toISOString(),
  };
}

/**
 * Download, validate, and atomically install one mined skill. A directory
 * without our marker is always considered user-owned and is never replaced.
 */
export async function syncOneSkill(
  client: SkillSyncClient,
  skillsDirectory: string,
  summary: RemoteSkillSummary,
  source: SkillSyncSource,
): Promise<SkillSyncResult> {
  try {
    const detail = await client.get(summary.skill_id);
    const name = safeSkillName(detail.content);
    if (!name) throw new Error("remote SKILL.md has no valid Pi skill name");
    if (Buffer.byteLength(detail.content, "utf8") > MAX_SKILL_MD_BYTES) {
      throw new Error(`SKILL.md exceeds ${MAX_SKILL_MD_BYTES} bytes`);
    }

    const target = join(skillsDirectory, name);
    const expectedMarker = markerFor(detail, source);
    const existingMarker = await readMarker(join(target, MARKER_FILE));
    if (await isDirectory(target) && !existingMarker) {
      return { skillId: detail.skill_id, name, version: detail.version, status: "skipped-user-owned" };
    }
    if (existingMarker && existingMarker.skillId !== detail.skill_id) {
      return { skillId: detail.skill_id, name, version: detail.version, status: "skipped-remote-conflict" };
    }
    if (
      existingMarker?.skillId === expectedMarker.skillId &&
      existingMarker.version === expectedMarker.version &&
      existingMarker.skillMdSha256 === expectedMarker.skillMdSha256
    ) {
      return { skillId: detail.skill_id, name, version: detail.version, status: "up-to-date" };
    }

    const resources: RemoteSkillFile[] = [];
    let totalBytes = Buffer.byteLength(detail.content, "utf8");
    for (const rawPath of detail.script_paths ?? []) {
      const path = safeResourcePath(rawPath);
      if (!path) throw new Error(`remote skill has unsafe resource path: ${rawPath}`);
      const file = await client.readFile(detail.skill_id, path);
      const bytes = byteLength(file.content, file.encoding);
      if (bytes > MAX_RESOURCE_BYTES) throw new Error(`resource ${path} exceeds ${MAX_RESOURCE_BYTES} bytes`);
      totalBytes += bytes;
      if (totalBytes > MAX_PACKAGE_BYTES) throw new Error(`skill package exceeds ${MAX_PACKAGE_BYTES} bytes`);
      resources.push({ ...file, path });
    }

    await mkdir(skillsDirectory, { recursive: true });
    const stageRoot = join(skillsDirectory, `.tdai-sync-stage-${randomUUID()}`);
    const staged = join(stageRoot, name);
    const backup = join(skillsDirectory, `.tdai-sync-backup-${randomUUID()}`);
    try {
      await writeFileWithin(staged, "SKILL.md", detail.content);
      for (const resource of resources) {
        const body = resource.encoding === "base64" ? Buffer.from(resource.content, "base64") : resource.content;
        await writeFileWithin(staged, resource.path, body);
      }
      await writeFileWithin(staged, MARKER_FILE, `${JSON.stringify(expectedMarker, null, 2)}\n`);

      const loaded = loadSkillsFromDir({ dir: stageRoot, source: "user" });
      if (!loaded.skills.some((skill) => skill.name === name)) {
        throw new Error(loaded.diagnostics[0]?.message ?? "staged skill is not valid for Pi");
      }

      if (await isDirectory(target)) await renameWithRetry(target, backup);
      try {
        await renameWithRetry(staged, target);
      } catch (error) {
        await rm(target, { recursive: true, force: true });
        if (await isDirectory(backup)) await renameWithRetry(backup, target);
        throw error;
      }
      await rm(backup, { recursive: true, force: true });
    } finally {
      await rm(stageRoot, { recursive: true, force: true });
    }

    return { skillId: detail.skill_id, name, version: detail.version, status: "synced" };
  } catch (error) {
    return {
      skillId: summary.skill_id,
      name: summary.name,
      version: summary.version,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function syncAllSkills(
  client: SkillSyncClient,
  skillsDirectory: string,
  source: SkillSyncSource,
): Promise<SkillSyncResult[]> {
  const summaries = await client.list();
  return syncListedSkills(client, skillsDirectory, source, summaries);
}

export function syncListedSkills(
  client: SkillSyncClient,
  skillsDirectory: string,
  source: SkillSyncSource,
  summaries: readonly RemoteSkillSummary[],
): Promise<SkillSyncResult[]> {
  return Promise.all(summaries.map((summary) => syncOneSkill(client, skillsDirectory, summary, source)));
}
