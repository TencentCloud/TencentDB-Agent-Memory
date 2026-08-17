import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SkillClient, SkillDetail, SkillManifestEntry, SkillSummary } from "@tencentdb-agent-memory/memory-sdk-ts-v2";
import { getAgentDir, loadSkillsFromDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

/**
 * Sync remote (server-reviewed) SKILL.md skills into Pi's native skills
 * directory so they are discovered like any user-written skill.
 *
 * Landing path is `<agentDir>/skills/<name>/` — Pi's `loadSkillsFromDir`
 * treats a directory containing SKILL.md as a skill root and ignores every
 * other file inside it, so a `tdai-remote.json` ownership marker is safe.
 *
 * A skill directory that exists WITHOUT that marker is a hand-written user
 * skill and is never overwritten. Remote content is validated (frontmatter,
 * path traversal, sizes) before an atomic replace; any failure leaves the
 * previous version intact.
 */

const SYNC_MARKER = "tdai-remote.json";
const MAX_SKILL_MD_BYTES = 1 * 1024 * 1024; // 1 MiB
const MAX_RESOURCE_BYTES = 5 * 1024 * 1024; // 5 MiB (server cap)
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
// Pi Agent Skills spec: lowercase a-z / 0-9 / hyphens, no leading/trailing or
// consecutive hyphens (mirrors `validateName` in pi's core/skills.ts).
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TEXT_PATH_RE = /\.(md|txt|sh|bash|yaml|yml|json|ts|js|mjs|sql|env|conf|toml|ini)$/i;

export interface RemoteSkillFile {
  path: string;
  content: string;
  encoding: "utf-8" | "base64";
  sizeBytes: number;
}

export interface FetchedSkill {
  skillId: string;
  name: string;
  description: string;
  version: number;
  updatedAtMs: number;
  skillMd: string;
  resources: RemoteSkillFile[];
}

export type SyncStatus = "synced" | "skipped-user-owned" | "failed";

export interface SyncResult {
  status: SyncStatus;
  name: string;
  version: number;
  skillId: string;
  error?: string;
}

export interface SyncSource {
  endpoint: string;
  teamId: string;
  agentId: string;
}

export interface InstallOptions {
  skill: SkillClient;
  agentDir: string;
  skillId: string;
  source?: SyncSource;
}

export async function listSyncCandidates(skill: SkillClient): Promise<SkillSummary[]> {
  const result = await skill.list();
  return result.items;
}

function safeResourcePath(raw: string): string | undefined {
  if (!raw || raw.includes("\0")) return undefined;
  // Normalise Windows separators so a `..\..` or `C:\` backslash path cannot
  // slip past a forward-slash-only check.
  const normalized = raw.replaceAll("\\", "/");
  if (normalized.startsWith("/")) return undefined; // absolute
  if (/^[A-Za-z]:\//.test(normalized)) return undefined; // Windows drive
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) return undefined; // traversal
  if (segments.some((segment) => segment === "" || segment === ".")) return undefined; // weird empties
  if (normalized === "SKILL.md" || normalized === SYNC_MARKER) return undefined; // reserved
  return normalized;
}

function resourceEncodingFor(path: string, mimeType: string | undefined): "utf-8" | "base64" {
  if (mimeType?.startsWith("text/")) return "utf-8";
  if (TEXT_PATH_RE.test(path)) return "utf-8";
  return "base64";
}

export async function fetchRemoteSkill(skill: SkillClient, skillId: string): Promise<FetchedSkill> {
  const detail: SkillDetail = await skill.get({
    skill_id: skillId,
    include_content: true,
    include_manifest: true,
  });
  if (!detail.content) throw new Error("remote skill has no SKILL.md content");

  const { frontmatter } = parseFrontmatter(detail.content);
  const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
  const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  if (!NAME_RE.test(name)) {
    throw new Error(`invalid skill name "${name || "(empty)"}" (must be lowercase letters, digits, hyphens)`);
  }
  if (!description) throw new Error(`skill "${name}" has an empty description`);

  if (Buffer.byteLength(detail.content, "utf8") > MAX_SKILL_MD_BYTES) {
    throw new Error(`skill "${name}" SKILL.md exceeds ${MAX_SKILL_MD_BYTES} bytes`);
  }

  const resources: RemoteSkillFile[] = [];
  let totalBytes = Buffer.byteLength(detail.content, "utf8");
  for (const entry of detail.manifest ?? []) {
    const path = safeResourcePath(entry.path);
    if (!path) throw new Error(`skill "${name}" has an unsafe resource path "${entry.path}"`);
    // Pre-check the manifest's declared size before downloading a huge file;
    // the read result is then re-checked in case the server lies.
    if (entry.size_bytes > MAX_RESOURCE_BYTES) {
      throw new Error(`skill "${name}" resource "${path}" exceeds ${MAX_RESOURCE_BYTES} bytes`);
    }
    const file = await skill.readFile({ skill_id: skillId, path, encoding: resourceEncodingFor(path, entry.mime_type) });
    totalBytes += file.size_bytes;
    if (file.size_bytes > MAX_RESOURCE_BYTES) {
      throw new Error(`skill "${name}" resource "${path}" exceeds ${MAX_RESOURCE_BYTES} bytes`);
    }
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(`skill "${name}" package exceeds ${MAX_TOTAL_BYTES} bytes`);
    }
    resources.push({ path, content: file.content, encoding: file.encoding, sizeBytes: file.size_bytes });
  }

  return {
    skillId,
    name,
    description,
    version: detail.version,
    updatedAtMs: detail.updated_at_ms,
    skillMd: detail.content,
    resources,
  };
}

function markerJson(fetched: FetchedSkill, source: SyncSource | undefined): string {
  const hash = createHash("sha256").update(fetched.skillMd, "utf8").digest("hex");
  return `${JSON.stringify(
    {
      adapter: "tdai-memory",
      skillId: fetched.skillId,
      version: fetched.version,
      source: source
        ? { endpoint: source.endpoint, teamId: source.teamId, agentId: source.agentId }
        : undefined,
      syncedAt: new Date().toISOString(),
      skillMdSha256: hash,
    },
    null,
    2,
  )}\n`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path);
    return Array.isArray(entries);
  } catch {
    return false;
  }
}

async function writeStagedFile(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Never set executable bits on remote content, and do not run scripts.
  await writeFile(path, content, { encoding: "utf8", mode: 0o644, flag: "w" });
}

/**
 * Download, validate and atomically install one remote skill into
 * `<agentDir>/skills/<name>/`. Returns a structured result rather than
 * throwing for the expected conflict outcome; validation failures throw.
 */
export async function installSyncedSkill(options: InstallOptions): Promise<SyncResult> {
  const fetched = await fetchRemoteSkill(options.skill, options.skillId);
  const skillsDir = join(options.agentDir, "skills");
  const targetDir = join(skillsDir, fetched.name);

  if (await isDirectory(targetDir)) {
    const markerPath = join(targetDir, SYNC_MARKER);
    if (!(await exists(markerPath))) {
      // A hand-written user skill owns this name; never overwrite it.
      return {
        status: "skipped-user-owned",
        name: fetched.name,
        version: fetched.version,
        skillId: fetched.skillId,
        error: "a user-written skill with this name already exists locally",
      };
    }
  }

  await mkdir(skillsDir, { recursive: true });
  const stagingRoot = join(skillsDir, `.tdai-sync-staging-${randomUUID()}`);
  const stageDir = join(stagingRoot, fetched.name);

  try {
    await mkdir(stageDir, { recursive: true });
    await writeStagedFile(join(stageDir, "SKILL.md"), fetched.skillMd);
    for (const resource of fetched.resources) {
      const bytes = resource.encoding === "base64" ? Buffer.from(resource.content, "base64") : resource.content;
      await writeStagedFile(join(stageDir, resource.path), bytes);
    }
    await writeStagedFile(join(stageDir, SYNC_MARKER), markerJson(fetched, options.source));

    // Verify the staged package loads as a Pi skill before replacing anything.
    const loaded = loadSkillsFromDir({ dir: stagingRoot, source: "user" });
    const found = loaded.skills.find((skill) => skill.name === fetched.name);
    if (!found) {
      const problem = loaded.diagnostics[0]?.message ?? "unknown reason";
      throw new Error(`staged skill "${fetched.name}" did not load: ${problem}`);
    }

    const backupDir = join(skillsDir, `.tdai-sync-backup-${randomUUID()}`);
    try {
      if (await isDirectory(targetDir)) await rename(targetDir, backupDir);
      await rename(stageDir, targetDir);
      await rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
    } catch (error) {
      // Roll back: restore the previous version, drop the half-installed one.
      await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
      if (await isDirectory(backupDir)) await rename(backupDir, targetDir).catch(() => undefined);
      throw error;
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  return {
    status: "synced",
    name: fetched.name,
    version: fetched.version,
    skillId: fetched.skillId,
  };
}

export async function defaultAgentDir(): Promise<string> {
  return getAgentDir();
}
