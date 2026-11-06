/**
 * ISkillStore — Skill 存储层抽象接口
 *
 * 用于解耦 SkillCore / SkillVersioning 与具体存储实现（SQLite / TCVDB）。
 * SqliteSkillStore（Standalone 模式）和 TcvdbSkillStore（Service 模式）
 * 各自实现本接口，消费者只依赖接口。
 *
 * 设计文档：
 *   - docs/design/2026-06-25-skill-service-mode-design.md §6.1
 *   - docs/design/2026-06-17-skill-redesign-v2.md
 */

import { createHash } from "node:crypto";
import type {
  AppendVersionInput,
  ListSkillsOptions,
  SearchSkillsOptions,
  Skill,
  SkillStatus,
} from "./types.js";

// ─── Errors (contract-level, backend-neutral) ──────────────────────────────

export type SkillErrorCode =
  | "SKILL_NAME_DUPLICATE"
  | "SKILL_NOT_FOUND"
  // Expected-version CAS failed in the database or publication authority.
  | "SKILL_VERSION_STALE"
  | "SKILL_MUTATION_CONFLICT"
  | "SKILL_PUBLICATION_UNKNOWN"
  | "SKILL_ASSET_REGISTRATION_PENDING"
  | "SKILL_DELETION_PENDING"
  | "SKILL_NOT_OWNER"
  | "INVALID_PATH"
  | "RESOURCE_TOO_LARGE"
  | "SKILL_PUBLICATION_COORDINATOR_REQUIRED";

export class SkillStoreError extends Error {
  constructor(public readonly code: SkillErrorCode, message?: string) {
    super(message ? `${code}: ${message}` : code);
    this.name = "SkillStoreError";
  }
}

/**
 * 当 appendVersion 的 content_hash 与当前 head 完全相同时抛出。
 * 由调用方决定如何处理（一般做幂等返回 head）。store 层不静默吞掉。
 */
export class IdempotentNoOpError extends Error {
  constructor(public readonly head: Skill) {
    super("IDEMPOTENT_NO_OP: content_hash unchanged");
    this.name = "IdempotentNoOpError";
  }
}

/** Deterministic JSON for payload equality, independent of object key order. */
export function canonicalSkillJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSkillJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter(k => record[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalSkillJson(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function skillPayloadHash(input: AppendVersionInput): string {
  if (input.mutation_id && (input.manifest ?? []).some(entry => !/^[a-f0-9]{64}$/.test(entry.content_sha256 ?? ""))) {
    throw new SkillStoreError("SKILL_MUTATION_CONFLICT", "resource mutation requires manifest content_sha256 fingerprints");
  }
  // storage_dir is an attempt location, not part of the logical intent. Bytes
  // are represented by the manifest's content_sha256 when supplied by versioning.
  const { storage_dir: _dir, mutation_id: _id, ...payload } = input;
  return createHash("sha256").update(canonicalSkillJson({
    ...payload,
    user_id: input.user_id ?? "default", team_id: input.team_id ?? "default",
    task_id: input.task_id ?? "default", owner_agent_id: input.owner_agent_id ?? "default",
    metadata_json: input.metadata_json ?? "{}",
    manifest: [...(input.manifest ?? [])].sort((a, b) => a.path.localeCompare(b.path)),
  })).digest("hex");
}

export function assertSkillMutationMatch(row: Skill, input: AppendVersionInput): Skill {
  if (!input.mutation_id || row.mutation_id !== input.mutation_id || row.mutation_payload_hash !== skillPayloadHash(input)) {
    throw new SkillStoreError("SKILL_MUTATION_CONFLICT", "mutation id was reused with a different payload");
  }
  return row;
}

export function assertSkillExpectedVersion(input: Pick<AppendVersionInput, "expected_version" | "mutation_id">, head: Skill | null): void {
  const expected = input.expected_version;
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0 || expected !== (head?.version ?? 0))) {
    throw new SkillStoreError("SKILL_VERSION_STALE", `expected ${expected}, current ${head?.version ?? 0}`);
  }
  if (head && head.status !== "active") throw new SkillStoreError("SKILL_VERSION_STALE", "head is archived");
  if (input.mutation_id !== undefined && !input.mutation_id.trim()) {
    throw new SkillStoreError("SKILL_MUTATION_CONFLICT", "mutation id must not be empty");
  }
}

export interface SkillPublicationScope {
  team_id: string;
  skill_id: string;
}

export interface SkillPublicationPointer {
  row_id: string;
  version: number;
  mutation_id: string;
  status?: SkillStatus;
}

export interface SkillPublicationRequest {
  scope: SkillPublicationScope;
  mutation_id: string;
  payload_hash: string;
  expected_version?: number;
  name: string;
  owner_agent_id: string;
  /** Authoritative/legacy head observed before prepare, for initial control bootstrap. */
  previous_head?: Skill | null;
}

export type SkillPublicationLookup =
  | { status: "committed"; skill: Skill; payload_hash: string }
  | { status: "absent" }
  | { status: "unknown" };

export interface SkillDeletionTarget {
  row_id: string;
  version: number;
  storage_dir: string;
}
export interface SkillDeletionRequest {
  scope: SkillPublicationScope;
  owner_agent_id: string;
  expected_head: SkillPublicationPointer;
  previous_head?: Skill;
  /** Trusted resource configuration, never a directory supplied by a stored row. */
  versionDirectory?: (version: number) => string;
}
export interface SkillDeletionReceipt {
  deletion_id: string;
  scope: SkillPublicationScope;
  owner_agent_id: string;
  name: string;
  original_head: SkillPublicationPointer;
  phase: "pending" | "complete";
  targets: SkillDeletionTarget[];
  created_at_ms: number;
}
export interface SkillDeletionResult {
  receipt: SkillDeletionReceipt;
  /** True only for the cleanup attempt that confirms completion. */
  completed_now: boolean;
  deleted_rows: number;
}
export type SkillDeletionGuard = () => Promise<void>;
export type SkillDeletionCleanup = (receipt: SkillDeletionReceipt, guard: SkillDeletionGuard) => Promise<void>;
export const MAX_SKILL_DELETION_TARGETS = 4096;
export const MAX_SKILL_DELETION_BYTES = 900_000;

/** Frozen targets must never turn a row-controlled path into a root/prefix purge. */
export function assertSkillDeletionTargets(scope: SkillPublicationScope, targets: SkillDeletionTarget[], versionDirectory?: (version: number) => string): void {
  if (!scope.skill_id || /[\\/\\\\\0]/.test(scope.skill_id) || scope.skill_id === "." || scope.skill_id === "..") {
    throw new SkillStoreError("INVALID_PATH", "invalid skill identity for deletion");
  }
  if (targets.length > MAX_SKILL_DELETION_TARGETS || Buffer.byteLength(JSON.stringify(targets), "utf8") > MAX_SKILL_DELETION_BYTES) {
    throw new SkillStoreError("RESOURCE_TOO_LARGE", "deletion target plan exceeds 4096 rows or 900000 bytes; no targets were truncated");
  }
  const ids = new Set<string>();
  for (const target of targets) {
    if (!target.row_id || ids.has(target.row_id) || !Number.isSafeInteger(target.version) || target.version < 1) {
      throw new SkillStoreError("SKILL_MUTATION_CONFLICT", "invalid deletion target identity");
    }
    ids.add(target.row_id);
    if (!target.storage_dir) continue; // legacy resource-free rows have no directory
    const directory = target.storage_dir;
    const expected = versionDirectory?.(target.version) ?? `skills/${scope.skill_id}/v${target.version}`;
    const rootParts = expected.split("/");
    if (expected.includes("\\") || expected.includes("\0") || rootParts.some(part => !part || part === "." || part === "..") ||
        rootParts.length < 3 || rootParts.at(-2) !== scope.skill_id || rootParts.at(-1) !== `v${target.version}`) {
      throw new SkillStoreError("INVALID_PATH", "configured resource directory is not a skill/version root");
    }
    if (directory.includes("\\") || directory.includes("\0") || directory.split("/").some(part => !part || part === "." || part === "..") ||
        (directory !== expected && !directory.startsWith(`${expected}/`))) {
      throw new SkillStoreError("INVALID_PATH", `deletion directory does not belong to ${scope.skill_id} v${target.version}`);
    }
  }
}

export async function collectSkillDeletionTargets(store: ISkillStore, request: SkillDeletionRequest, guard: SkillDeletionGuard): Promise<SkillDeletionTarget[]> {
  await guard();
  const head = await store.getHeadIncludingArchived(request.scope.skill_id, request.scope.team_id);
  if (!head) throw new SkillStoreError("SKILL_NOT_FOUND");
  if (head.owner_agent_id !== request.owner_agent_id || head.team_id !== request.scope.team_id) throw new SkillStoreError("SKILL_NOT_OWNER");
  if (head.row_id !== request.expected_head.row_id || head.version !== request.expected_head.version) throw new SkillStoreError("SKILL_VERSION_STALE");
  const targets = new Map<string, SkillDeletionTarget>();
  const add = (row: Skill) => {
    if (row.skill_id !== request.scope.skill_id || row.team_id !== request.scope.team_id || row.owner_agent_id !== request.owner_agent_id) return;
    if (!row.storage_dir && row.manifest.length) throw new SkillStoreError("INVALID_PATH", "resource-bearing deletion row has no directory");
    const target = { row_id: row.row_id, version: row.version, storage_dir: row.storage_dir };
    assertSkillDeletionTargets(request.scope, [target], request.versionDirectory);
    const previous = targets.get(target.row_id);
    if (previous && (previous.version !== target.version || previous.storage_dir !== target.storage_dir)) throw new SkillStoreError("SKILL_PUBLICATION_UNKNOWN", "inconsistent deletion target snapshot");
    targets.set(target.row_id, target);
    if (targets.size > MAX_SKILL_DELETION_TARGETS) throw new SkillStoreError("RESOURCE_TOO_LARGE", "deletion history exceeds 4096 rows; nothing was truncated");
  };
  add(head);
  let scanned = 0;
  for (let offset = 0; ; offset += 256) {
    const rows = await store.listVersions(request.scope.skill_id, request.scope.team_id, { limit: 256, offset });
    await guard();
    scanned += rows.length;
    if (scanned > MAX_SKILL_DELETION_TARGETS) throw new SkillStoreError("RESOURCE_TOO_LARGE", "deletion history exceeds 4096 rows; nothing was truncated");
    rows.forEach(add);
    if (rows.length < 256) break;
  }
  const result = [...targets.values()];
  assertSkillDeletionTargets(request.scope, result, request.versionDirectory);
  return result;
}

/**
 * External authority for stores without multi-row transactions/unique inserts.
 * execute must durably claim intent+payload and atomically CAS head+receipt
 * AFTER prepare returns an immutable candidate. It must serialize the skill
 * and enforce the (team, owner, name) uniqueness domain, bootstrap legacy head,
 * and never release an unknown publication solely because its lease expired.
 * A timed-out prepare may still write a candidate, but cannot advance this
 * pointer. The coordinator owns fencing/CAS, recovery, and receipt retention.
 * This is NOT a cross-system transaction. Prepared rows/bytes can be orphaned.
 */
export interface SkillPublicationCoordinator {
  execute(request: SkillPublicationRequest, prepare: () => Promise<Skill>): Promise<Skill>;
  lookup(scope: SkillPublicationScope, mutationId: string): Promise<SkillPublicationLookup>;
  /** undefined = unmanaged legacy; null = managed with no published head. */
  getHead(scope: SkillPublicationScope): Promise<SkillPublicationPointer | null | undefined>;
  /** Aligned, lightweight head pointers. Callers issue batches of at most 256. */
  getHeads?(scopes: SkillPublicationScope[]): Promise<Array<SkillPublicationPointer | null | undefined>>;
  /** Only an explicit deleted head exposes this receipt; an unpublished null pointer never does. */
  getDeletionReceipt?(scope: { skill_id: string; team_id?: string }): Promise<SkillDeletionReceipt | null>;
  deleteWithReceipt?(
    request: SkillDeletionRequest,
    prepare: (guard: SkillDeletionGuard) => Promise<SkillDeletionTarget[]>,
    cleanup: (receipt: SkillDeletionReceipt, guard: SkillDeletionGuard) => Promise<number>,
    options?: { complete?: boolean },
  ): Promise<SkillDeletionResult>;
  /** Legacy status primitive; recoverable row/resource deletion uses deleteWithReceipt. */
  remove(scope: SkillPublicationScope, expected: SkillPublicationPointer | null, removeRows: () => Promise<number>, previousHead?: Skill): Promise<number>;
  /** Atomically archive the pointer before best-effort physical flag maintenance. */
  archive(scope: SkillPublicationScope, expected: SkillPublicationPointer, archiveRows: () => Promise<void>, previousHead?: Skill): Promise<void>;
}

export type SkillPublicationCandidate = Pick<Skill, "row_id" | "skill_id" | "team_id" | "version" | "is_head" | "status" | "mutation_id">;

/** Project lightweight candidates before loading their package bodies. Current
 * heads are proved by the pointer itself; only historical candidates need a
 * receipt lookup. Older authorities use bounded concurrency, never N serial
 * head requests or unbounded Promise.all across a whole result set. */
export async function projectPublishedCandidates<T extends SkillPublicationCandidate>(
  rows: T[], coordinator?: SkillPublicationCoordinator, currentOnly = false,
): Promise<T[]> {
  const scopeKey = (row: SkillPublicationScope) => JSON.stringify([row.team_id, row.skill_id]);
  const scopeMap = new Map<string, SkillPublicationScope>();
  for (const row of rows) scopeMap.set(scopeKey(row), { team_id: row.team_id, skill_id: row.skill_id });
  const scopes = [...scopeMap.values()];
  const pointers = new Map<string, SkillPublicationPointer | null | undefined>();
  for (let offset = 0; offset < scopes.length; offset += 256) {
    const batch = scopes.slice(offset, offset + 256);
    if (coordinator?.getHeads) {
      const result = await coordinator.getHeads(batch);
      if (result.length !== batch.length) throw new SkillStoreError("SKILL_PUBLICATION_UNKNOWN", "misaligned head batch");
      batch.forEach((scope, index) => pointers.set(scopeKey(scope), result[index]));
    } else {
      for (let index = 0; index < batch.length; index += 16) {
        const group = batch.slice(index, index + 16);
        const result = await Promise.all(group.map(scope => coordinator?.getHead(scope)));
        group.forEach((scope, i) => pointers.set(scopeKey(scope), result[i]));
      }
    }
  }
  const receipts = new Map<string, Promise<SkillPublicationLookup>>();
  const project = async (row: T): Promise<T | null> => {
    const key = scopeKey(row);
    const pointer = pointers.get(key);
    if (pointer === null) return null;
    if (pointer === undefined) return !row.mutation_id && (!currentOnly || row.is_head) ? row : null;
    if (pointer.row_id === row.row_id && (!row.mutation_id || pointer.mutation_id === row.mutation_id)) {
      return { ...row, is_head: true, status: pointer.status ?? row.status };
    }
    if (currentOnly) return null;
    if (row.mutation_id) {
      if (!coordinator) return null;
      const receiptKey = JSON.stringify([key, row.mutation_id]);
      let promise = receipts.get(receiptKey);
      if (!promise) {
        promise = coordinator.lookup({ team_id: row.team_id, skill_id: row.skill_id }, row.mutation_id);
        receipts.set(receiptKey, promise);
      }
      const receipt = await promise;
      if (receipt.status !== "committed" || receipt.skill.row_id !== row.row_id) return null;
    }
    return { ...row, is_head: false };
  };
  const result: T[] = [];
  for (let offset = 0; offset < rows.length; offset += 16) {
    const group = await Promise.all(rows.slice(offset, offset + 16).map(project));
    for (const row of group) {
      if (row !== null) result.push(row);
    }
  }
  return result;
}

export async function projectPublishedSkill(row: Skill, coordinator?: SkillPublicationCoordinator): Promise<Skill | null> {
  return (await projectPublishedCandidates([row], coordinator))[0] ?? null;
}

export async function lookupSkillMutation(
  coordinator: SkillPublicationCoordinator | undefined, scope: SkillPublicationScope, mutationId: string,
): Promise<Skill | null> {
  if (!coordinator) return null;
  const receipt = await coordinator.lookup(scope, mutationId);
  if (receipt.status === "unknown") throw new SkillStoreError("SKILL_PUBLICATION_UNKNOWN", mutationId);
  return receipt.status === "committed" ? receipt.skill : null;
}

// ─── Capabilities ──────────────────────────────────────────────────────────

/** Store 能力声明，用于检索降级判断 */
export interface SkillStoreCapabilities {
  /** 密集向量搜索可用 */
  vectorSearch: boolean;
  /** BM25 稀疏向量搜索可用 */
  ftsSearch: boolean;
  /** TCVDB 原生 hybridSearch 可用（本地模式 false） */
  nativeHybridSearch: boolean;
  /** 稀疏向量支持 */
  sparseVectors: boolean;
}

// ─── Search Result ─────────────────────────────────────────────────────────

export interface SkillSearchResult {
  skill: Skill;
  score: number;
  snippet?: string;
}

// ─── TTL Cleanup Meta ──────────────────────────────────────────────────────

/** TTL 清理用的过期版本元信息（轻量，不读 content/manifest）。 */
export interface ExpiredVersionMeta {
  skill_id: string;
  version: number;
  is_head: boolean;
  status: SkillStatus;
  storage_dir: string;
  created_at_ms: number;
}

// ─── Store Interface ───────────────────────────────────────────────────────

export interface ISkillStore {
  /** Bind before exposing Core; rebinding must target the same instance/namespace authority. */
  setPublicationCoordinator?(coordinator: SkillPublicationCoordinator): void;
  getDeletionReceipt?(skillId: string, teamId?: string): Promise<SkillDeletionReceipt | null>;
  /** Remote durable delete; cleanup must finish resource and lifecycle hooks before completion. */
  deleteWithReceipt?(request: SkillDeletionRequest, cleanup: SkillDeletionCleanup, options?: { complete?: boolean }): Promise<SkillDeletionResult>;
  // ── 生命周期 ──
  /** 初始化存储（建表/建 Collection 等）。 */
  init(): void;
  /** 是否处于降级模式（不可用） */
  isDegraded(): boolean;
  /** 获取 store 能力声明 */
  getCapabilities(): SkillStoreCapabilities;
  /** 关闭存储（释放连接等） */
  close(): void;

  // ── CRUD ──
  /** Append with expected-version CAS and payload-checked mutation replay. */
  appendVersion(input: AppendVersionInput): Promise<Skill>;
  /** Strict committed-result lookup. Unavailable/ambiguous is an error, never null. */
  getByMutationId(skillId: string, mutationId: string, teamId?: string): Promise<Skill | null>;
  /**
   * 获取当前 head 版本（is_head=1 且 status='active'）。
   *
   * 语义：`archived` 视同"逻辑删除"，对外任何普通读接口都不可见——本方法一律返回 null。
   * 需要看到 archived head 用 {@link getHeadIncludingArchived}（仅供 `SkillCore.delete`
   * 幂等回读、TTL cleaner、管控台等内部路径使用）。
   */
  getHead(skillId: string, teamId?: string): Promise<Skill | null>;
  /**
   * 获取当前 head 版本，包含 archived。
   *
   * 仅供内部使用：
   *   - `SkillCore.delete` 需要拿到 archived head 才能实现幂等 `{ archived: true }`
   *   - 后台补偿任务扫描 archived skill 与 asset 漂移
   *   - 管控台"回收站"视图
   *
   * 普通读/写路径 **不应** 调用本方法——用 `getHead`。
   */
  getHeadIncludingArchived(skillId: string, teamId?: string): Promise<Skill | null>;
  /** 获取指定版本行 */
  getByVersion(skillId: string, version: number, teamId?: string): Promise<Skill | null>;
  /** 将 head 标记为 archived（软删） */
  archiveHead(skillId: string, teamId?: string): Promise<{ archived: boolean }>;

  // ── 查询 ──
  /** 列出 head 行，支持五元组过滤 + 分页 */
  listSkills(opts: ListSkillsOptions): Promise<{ items: Skill[]; total: number }>;
  /** 搜索 skill（BM25 / embedding / hybrid，由实现决定） */
  searchSkills(opts: SearchSkillsOptions): Promise<SkillSearchResult[]>;
  /** 列出某 skill 的全部版本（DESC） */
  listVersions(skillId: string, teamId?: string, pagination?: { limit?: number; offset?: number }): Promise<Skill[]>;
  /** 某 skill 的版本总数 */
  countVersions(skillId: string, teamId?: string): Promise<number>;

  // ── TTL Cleanup ──
  /** 查询 created_at_ms < cutoffMs 的过期非 head 版本（跨 team 全量扫描）。 */
  findExpiredVersions(cutoffMs: number): Promise<ExpiredVersionMeta[]>;
  /** 物理删除指定版本行（仅 is_head=0）。返回是否实际删除了行。 */
  deleteVersion(skillId: string, version: number): Promise<boolean>;
  /**
   * 物理删除同 skill_id 下的**所有版本行**（含 head + archived）。
   * 返回实际删除的行数（可能为 0：skill 不存在 / team 不匹配）。
   *
   * 用于 `SkillCore.delete` 的真删除路径，与 `deleteVersion` 的 head 保护相反：
   * 这里承担"以 skill 为整体单位一次性清空"的语义，权限校验由调用方
   * （SkillCore）先完成。
   *
   * 语义：
   *   - `teamId` 传入 → WHERE 强制过滤，跨 team 不生效（返回 0）
   *   - `teamId` 省略 → 跨 team 删除（供管控台 / 后台补偿任务使用，业务路径不应调用）
   */
  deleteAllVersions(skillId: string, teamId?: string): Promise<number>;
}
