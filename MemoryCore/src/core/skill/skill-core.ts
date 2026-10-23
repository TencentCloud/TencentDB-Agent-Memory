/**
 * SkillCore — 6 个 manage action 的编排门面
 *
 * 编排逻辑：
 *   1. 解析 + 校验 SKILL.md（frontmatter）
 *   2. 取 head（如有）
 *   3. assertTeamMatch / assertOwner / assertVersionFresh
 *   4. 调 SkillVersioning.appendNextVersion / createNewSkill
 *
 * 6 个写动作：
 *   - create        新建 skill v1
 *   - update        替换 SKILL.md
 *   - patch         单点串替
 *   - delete        head status=archived
 *   - writeFiles    增/改资源
 *   - removeFiles   删资源
 *
 * 4 个读动作：
 *   - get           返回 detail（默认 head；可指定 version）
 *   - list          按 team_id + filters 返回 head 行
 *   - search        FTS 命中
 *   - listVersions  历史版本元信息
 *   - readFile      读资源字节
 */

import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { parse as parseYaml } from "yaml";
import { parseSkillFile, SKILL_BODY_MAX, validateSkillFile } from "./skill-format.js";
import { SkillResourceStore, type SkillResourcePayload } from "./skill-resource-store.js";
import { assertSkillDeletionTargets, type ISkillStore, type SkillSearchResult } from "./skill-store.interface.js";
import { SkillVersioning } from "./skill-versioning.js";
import { randomBase62 } from "../../utils/short-id.js";
import {
  SkillPermissionError,
  assertOwner,
  assertTeamMatch,
  assertVersionFresh,
} from "./skill-permission.js";
import type {
  IdFields,
  ListSkillsOptions,
  SearchSkillsOptions,
  SkillStatus,
  Skill,
  SkillSimilarityResult,
  SkillProposeResult,
} from "./types.js";


const TAG = "[skill-core]";

// ═════════════════════════════════════════════════════════════════════
//  错误类型（用于 gateway 映射 HTTP 错误码）
// ═════════════════════════════════════════════════════════════════════


export type SkillCoreErrorCode =
  | "INVALID_FRONTMATTER"
  | "SKILL_FRONTMATTER_INVALID"
  | "SKILL_PATCH_NOT_UNIQUE"
  | "SKILL_NAME_DUPLICATE"
  | "SKILL_NOT_OWNER"
  | "SKILL_TEAM_MISMATCH"
  | "SKILL_NOT_FOUND"
  | "SKILL_VERSION_STALE"
  | "SKILL_VERSION_EXPIRED"
  | "SKILL_ID_COLLISION"
  | "SKILL_MUTATION_CONFLICT"
  | "SKILL_PUBLICATION_UNKNOWN"
  | "SKILL_PUBLICATION_COORDINATOR_REQUIRED"
  | "SKILL_PUBLICATION_BUSY"
  | "SKILL_ASSET_REGISTRATION_PENDING"
  | "SKILL_DELETION_PENDING"
  | "SKILL_PROTECTED"
  | "RESOURCE_INTEGRITY_ERROR"
  | "INVALID_PATH"
  | "RESOURCE_TOO_LARGE"
  | "STORAGE_NOT_FOUND"
  | "LLM_UNAVAILABLE"
  | "SKILL_COS_REQUIRED"
  | "SKILL_EXPORT_TOO_LARGE";

export class SkillCoreError extends Error {
  constructor(public readonly code: SkillCoreErrorCode, message?: string) {
    super(message ? `${code}: ${message}` : code);
    this.name = "SkillCoreError";
  }
}

// 工具：把下层抛的各类错误统一翻译为 SkillCoreError（保留原 message）
function toCoreError(e: unknown): never {
  if (e instanceof SkillCoreError) throw e;
  const code = (e as { code?: string }).code as SkillCoreErrorCode | undefined;
  const msg = (e as Error).message;
  if (code) {
    throw new SkillCoreError(code, msg);
  }
  throw e as Error;
}

// ═════════════════════════════════════════════════════════════════════
//  Options
// ═════════════════════════════════════════════════════════════════════

export interface SkillCoreOptions {
  store: ISkillStore;
  resources: SkillResourceStore;
  versioning: SkillVersioning;
  /**
   * 用于 skill_id 生成。默认 `skl-` + 12 字符 base62（CSPRNG，71 bit 真熵）。
   * 保持与老 sid 相同长度 (16 字符)，仅字符集从 base36 扩到 base62 且用真随机源。
   * 测试可注入固定值。
   */
  ulid?: () => string;
  /** Date.now 的注入。默认 Date.now。 */
  now?: () => number;
  /** 旧版本 TTL 秒数。0 = 关闭。 */
  versionTtlSeconds?: number;
  /** 每个 skill 最多保留的非 head 版本数。0 = 关闭。 */
  maxNonHeadVersions?: number;
  /**
   * Idempotent asset lifecycle cleanup. Durable remote deletion awaits this
   * promise before marking its receipt complete; failures remain recoverable.
   * The legacy SQLite deletion path retains its existing best-effort behavior.
   */
  onSkillArchived?: (params: { skill_id: string; team_id?: string }) => void | Promise<void>;
  /**
   * 读路径自愈补登记钩子。
   *
   * 触发时机：`get` / `readFile` 成功返回单个 skill 之后。
   * 不触发：`list` / `search` / `listing` / `listVersions`（浏览类，一次 N 条，
   * 走 LRU 也偏贵；且这些接口不必然代表"使用"）。
   *
   * 契约：
   *  - fire-and-forget：抛异常吞掉，不影响 read 的返回
   *  - 上层实现须幂等且带 LRU（同一 skill_id 只有首次真正查 store）
   *  - 用途：兜底修复 asset 缺失（历史数据 / 迁移遗漏 / 人工误删），
   *    保证下次前端管控页能看到这个 skill
   */
  onSkillAccessed?: (skill: Skill) => void;
}

// 各 action 入参类型（四个 ID 全部可选）
export interface CreateInput extends IdFields {
  name: string;
  content: string;
  resources?: SkillResourcePayload[];
  metadata?: Record<string, unknown>;
}

export interface CreatePackageVersionInput extends CreateInput {
  skill_id: string;
  mutation_id: string;
}

export interface ApplyPackageMutationInput extends IdFields {
  skill_id: string;
  expected_version: number;
  mutation_id: string;
  content: string;
  /** Complete final resource set, not a partial patch. */
  resources: SkillResourcePayload[];
  /** Caller supplies merged user metadata; omission preserves the base version. */
  metadata?: Record<string, unknown>;
}

export interface ReadPackageInput extends IdFields {
  skill_id: string;
  expected_version: number;
}

export interface UpdateInput extends IdFields {
  skill_id: string;
  expected_version: number;
  content: string;
}

export interface PatchInput extends IdFields {
  skill_id: string;
  expected_version: number;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface DeleteInput extends IdFields {
  skill_id: string;
}

export interface GetInput extends IdFields {
  skill_id: string;
  version?: number;
  include_content?: boolean;
  include_manifest?: boolean;
}

export interface WriteFilesInput extends IdFields {
  skill_id: string;
  expected_version: number;
  files: SkillResourcePayload[];
}

export interface RemoveFilesInput extends IdFields {
  skill_id: string;
  expected_version: number;
  paths: string[];
}

export interface ReadFileInput extends IdFields {
  skill_id: string;
  version?: number;
  path: string;
  encoding?: "utf-8" | "base64";
}

export interface ExportInput extends IdFields {
  skill_id: string;
  version?: number;
  format?: "zip";
}

export interface ListInput extends IdFields {
  filters?: {
    owner_agent_id?: string;
    name_prefix?: string;
    status?: SkillStatus[];
  };
  pagination?: { limit?: number; offset?: number };
}

export interface SearchInput extends IdFields {
  query: string;
  top_k?: number;
  mode?: "bm25" | "embedding" | "hybrid";
}

export interface ListVersionsInput extends IdFields {
  skill_id: string;
  pagination?: { limit?: number; offset?: number };
}

// ═════════════════════════════════════════════════════════════════════
//  Implementation
// ═════════════════════════════════════════════════════════════════════

export class SkillCore {
  private readonly store: ISkillStore;
  private readonly resources: SkillResourceStore;
  private readonly versioning: SkillVersioning;
  private readonly ulid: () => string;
  private readonly now: () => number;
  private readonly versionTtlSeconds: number;
  private readonly maxNonHeadVersions: number;
  private readonly onSkillArchived?: SkillCoreOptions["onSkillArchived"];
  private readonly onSkillAccessed?: SkillCoreOptions["onSkillAccessed"];

  constructor(opts: SkillCoreOptions) {
    this.store = opts.store;
    this.resources = opts.resources;
    this.versioning = opts.versioning;
    // 默认 sid = `skl-` + 12 字符 base62（CSPRNG，~71 bit 真熵）；总长 16。
    // 与旧 `skl-${Math.random().toString(36).slice(2,14)}` 相同长度，
    // 碰撞概率从单实例 100 万条时的 ~1.1e-4 降至 ~1.5e-10（详见 utils/short-id.ts）。
    this.ulid = opts.ulid ?? (() => `skl-${randomBase62(12)}`);
    this.now = opts.now ?? (() => Date.now());
    this.versionTtlSeconds = opts.versionTtlSeconds ?? 0;
    this.maxNonHeadVersions = opts.maxNonHeadVersions ?? 0;
    this.onSkillArchived = opts.onSkillArchived;
    this.onSkillAccessed = opts.onSkillAccessed;
  }

  /** 读路径读到具体 skill 后 fire。异常吞掉，不阻塞读。 */
  private notifyAccessed(skill: Skill): void {
    if (!this.onSkillAccessed) return;
    try { this.onSkillAccessed(skill); } catch { /* swallow */ }
  }

  // ───────────────────────────────────────────────────────────────────
  //  WRITE actions
  // ───────────────────────────────────────────────────────────────────

  /** Create a service-assigned identity; the backend owns durable intent replay. */
  async createPackageVersion(input: CreatePackageVersionInput): Promise<Skill> {
    const ctx = this.packageContext(input);
    this.assertMutationId(input.mutation_id);
    const file = this.parseAndValidate(input.content);
    if (file.frontmatter.name !== input.name) {
      throw new SkillCoreError("INVALID_FRONTMATTER", "frontmatter name must match the package name");
    }
    const payloads = this.packageResources(input.resources ?? []);
    this.assertPackageAllowed(input.content, input.metadata ?? {});
    try {
      // Global identity lookup prevents a caller from claiming another team's ID.
      const current = await this.store.getHeadIncludingArchived(input.skill_id);
      if (current) {
        assertTeamMatchWrap(current, ctx.team_id);
        assertOwnerWrap(current, ctx.agent_id, ctx.team_id);
        if (current.status !== "active") throw new SkillCoreError("SKILL_NOT_FOUND");
        this.assertPackageAllowed(current.content, this.packageMetadata(current));
      }
      const receipt = await this.store.getByMutationId(input.skill_id, input.mutation_id, ctx.team_id);
      if (receipt) {
        assertTeamMatchWrap(receipt, ctx.team_id);
        assertOwnerWrap(receipt, ctx.agent_id, ctx.team_id);
        // Receipts survive deletion. Replaying one must not recreate its asset.
        if (!current) throw new SkillCoreError("SKILL_NOT_FOUND", "the original package has been deleted");
      } else if (current) {
        throw new SkillCoreError("SKILL_ID_COLLISION", "the stable skill_id already belongs to a package");
      }
      return await this.versioning.createNewSkill(input.skill_id, ctx.agent_id, ctx, {
        mutation_id: input.mutation_id, expected_version: 0,
        content: input.content, name: input.name, description: file.frontmatter.description,
        resourcesToWrite: payloads,
        metadata_json: JSON.stringify(input.metadata ?? {}),
      });
    } catch (error) { toCoreError(error); }
  }

  /** Publish body, resource set and metadata together in one immutable version. */
  async applyPackageMutation(input: ApplyPackageMutationInput): Promise<Skill> {
    const ctx = this.packageContext(input);
    this.assertMutationId(input.mutation_id);
    this.assertPackageVersion(input.expected_version);
    const current = await this.requirePackageHead(input.skill_id, ctx);
    const file = this.parseAndValidate(input.content);
    if (file.frontmatter.name !== current.name) {
      throw new SkillCoreError("INVALID_FRONTMATTER", "name change is not allowed across package versions");
    }
    const payloads = this.packageResources(input.resources);
    try {
      // Derive removals and inherited metadata from the original expected version,
      // not today's head, so advancing the head cannot alter a retry's request hash.
      const base = current.version === input.expected_version ? current
        : await this.store.getByVersion(input.skill_id, input.expected_version, ctx.team_id);
      if (!base) throw new SkillCoreError("SKILL_VERSION_STALE", "the requested package base is unavailable");
      assertTeamMatchWrap(base, ctx.team_id);
      assertOwnerWrap(base, ctx.agent_id, ctx.team_id);
      this.assertPackageAllowed(base.content, this.packageMetadata(base));
      const metadata = input.metadata ?? this.packageMetadata(base);
      this.assertPackageAllowed(input.content, metadata);
      const finalPaths = new Set(payloads.map(payload => payload.path));
      const remove = base.manifest.map(entry => entry.path).filter(path => !finalPaths.has(path)).sort();
      // Authorization above is always checked, but stale checking stays in
      // versioning AFTER its durable receipt/request-hash lookup.
      return await this.versioning.appendNextVersion(base, {
        team_id: base.team_id, agent_id: base.owner_agent_id,
        user_id: ctx.user_id, task_id: ctx.task_id,
      }, {
        mutation_id: input.mutation_id, expected_version: input.expected_version,
        content: input.content, name: base.name, description: file.frontmatter.description,
        resourcesToWrite: payloads, resourcesToRemove: remove,
        metadata_json: input.metadata === undefined ? base.metadata_json : JSON.stringify(metadata),
      });
    } catch (error) { toCoreError(error); }
  }

  getPackageLimits(): { bodyChars: number; resourceBytes: number; totalResourceBytes: number } {
    return { bodyChars: SKILL_BODY_MAX, resourceBytes: this.resources.getMaxResourceSizeBytes(), totalResourceBytes: this.resources.getMaxSkillTotalBytes() };
  }

  /** Historical commit evidence for recovery, not proof that its resources remain live. */
  async lookupPackageMutation(input: IdFields & { skill_id: string; mutation_id: string }): Promise<Skill | null> {
    const ctx = this.packageContext(input);
    this.assertMutationId(input.mutation_id);
    const receipt = await this.store.getByMutationId(input.skill_id, input.mutation_id, ctx.team_id);
    if (receipt) {
      assertTeamMatchWrap(receipt, ctx.team_id);
      assertOwnerWrap(receipt, ctx.agent_id, ctx.team_id);
    }
    return receipt;
  }

  /** Strict semantic snapshot read; ordinary get/readFile retain their existing policy. */
  async readPackage(input: ReadPackageInput): Promise<{ skill: Skill; resources: SkillResourcePayload[] }> {
    const ctx = this.packageContext(input);
    this.assertPackageVersion(input.expected_version);
    const skill = await this.requirePackageHead(input.skill_id, ctx);
    assertVersionFreshWrap(skill, input.expected_version);
    const payloads: SkillResourcePayload[] = [];
    const seen = new Set<string>();
    try {
      for (const entry of skill.manifest) {
        if (seen.has(entry.path)) throw new SkillCoreError("RESOURCE_INTEGRITY_ERROR", "duplicate manifest resource path");
        seen.add(entry.path);
        const data = await this.resources.readResource(skill.skill_id, skill.version, entry.path, "base64", skill.storage_dir || undefined);
        if (!data || data.size_bytes !== entry.size_bytes ||
            (entry.content_sha256 !== undefined && createHash("sha256").update(Buffer.from(data.content, "base64")).digest("hex") !== entry.content_sha256)) {
          throw new SkillCoreError("RESOURCE_INTEGRITY_ERROR", `missing or corrupt package resource: ${entry.path}`);
        }
        payloads.push({ path: entry.path, content: data.content, encoding: "base64",
          mime_type: entry.mime_type, is_executable: entry.is_executable });
      }
      return { skill, resources: payloads };
    } catch (error) { toCoreError(error); }
  }

  async create(input: CreateInput): Promise<Skill> {
    // 1) parse + validate
    const file = this.parseAndValidate(input.content);
    if (file.frontmatter.name !== input.name) {
      throw new SkillCoreError("INVALID_FRONTMATTER", `frontmatter.name '${file.frontmatter.name}' != body.name '${input.name}'`);
    }

    // 2) 生成 sid 并做碰撞检测
    //
    // 背景：默认 ulid 走 CSPRNG base62 12 字符（~71 bit 真熵，单实例 100 万
    // skill 时碰撞概率 ~1.5e-10），工程上"永远不会撞"；但仍加一层 preflight
    // 防御，把"撞了静默覆盖"变成"撞了 retry"。为什么不上 DB UNIQUE 约束：
    //   - SQLite skills 表 UNIQUE(skill_id, version) 已存在，v1 碰撞会被物理挡住
    //   - TCVDB 主键是 row_id（每行唯一），无法给 skill_id 加"仅 v1 唯一"约束
    //     （skill 天生多版本，version 2/3 就是同 skill_id 共存）
    // → 应用层 preflight 是唯一可移植到两种 store 的方案。
    //
    // 注：注入的 ulid 工厂可能不带 'skl-' 前缀，这里兜底拼上。
    const MAX_ID_ATTEMPTS = 3;
    let sid = "";
    for (let attempt = 1; attempt <= MAX_ID_ATTEMPTS; attempt++) {
      const u = this.ulid();
      sid = u.startsWith("skl-") ? u : `skl-${u}`;

      // 全 team 范围查（不带 team_id）：只要 skill_id 全局撞了就重试。
      // 用 getHeadIncludingArchived 覆盖 archived 行——归档不代表 sid 空闲，
      // 版本表 UNIQUE(skill_id, version) 仍会挡住写入。
      const existing = await this.store.getHeadIncludingArchived(sid);
      if (!existing) break;

      if (attempt >= MAX_ID_ATTEMPTS) {
        // 连续 3 次撞 —— 只可能是 ulid 注入器坏了（比如测试里固定返回同一值）
        // 或熵源崩了，不是概率事件，直接抛。
        throw new SkillCoreError(
          "SKILL_ID_COLLISION",
          `failed to generate a unique skill_id after ${MAX_ID_ATTEMPTS} attempts`,
        );
      }
    }

    try {
      return await this.versioning.createNewSkill(
        sid,
        input.agent_id ?? "default",
        { user_id: input.user_id, team_id: input.team_id, agent_id: input.agent_id, task_id: input.task_id },
        {
          content: input.content,
          name: input.name,
          description: file.frontmatter.description,
          resourcesToWrite: input.resources,
          metadata_json: input.metadata ? JSON.stringify(input.metadata) : undefined,
        },
      );
    } catch (e) {
      toCoreError(e);
    }
  }

  async update(input: UpdateInput): Promise<Skill> {
    const head = await this.requireHead(input.skill_id, input.team_id);
    if (input.agent_id) assertOwnerWrap(head, input.agent_id, input.team_id);
    assertVersionFreshWrap(head, input.expected_version);

    const file = this.parseAndValidate(input.content);
    if (file.frontmatter.name !== head.name) {
      throw new SkillCoreError("INVALID_FRONTMATTER", "name change is not allowed across versions");
    }

    try {
      const result = await this.versioning.appendNextVersion(head, this.ctxOf(input), {
        content: input.content,
        name: head.name,
        description: file.frontmatter.description,
      });
      void this.versioning.cleanupExpiredVersionsForSkill(
        head.skill_id, this.versionTtlSeconds, this.maxNonHeadVersions,
      ).catch(() => { /* fire-and-forget */ });
      return result;
    } catch (e) {
      toCoreError(e);
    }
  }

  async patch(input: PatchInput): Promise<Skill> {
    const head = await this.requireHead(input.skill_id, input.team_id);
    if (input.agent_id) assertOwnerWrap(head, input.agent_id, input.team_id);
    assertVersionFreshWrap(head, input.expected_version);

    // count occurrences
    const occ = countOccurrences(head.content, input.old_string);
    if (occ === 0) {
      throw new SkillCoreError("SKILL_PATCH_NOT_UNIQUE", `old_string not found`);
    }
    if (occ > 1 && !input.replace_all) {
      throw new SkillCoreError("SKILL_PATCH_NOT_UNIQUE", `old_string occurs ${occ} times; pass replace_all=true to replace all`);
    }

    const newContent = input.replace_all
      ? splitJoin(head.content, input.old_string, input.new_string)
      : head.content.replace(input.old_string, input.new_string);

    // re-parse + validate
    const file = this.parseAndValidate(newContent);
    if (file.frontmatter.name !== head.name) {
      throw new SkillCoreError("INVALID_FRONTMATTER", "patch attempted to rename skill");
    }

    try {
      const result = await this.versioning.appendNextVersion(head, this.ctxOf(input), {
        content: newContent,
        name: head.name,
        description: file.frontmatter.description,
      });
      void this.versioning.cleanupExpiredVersionsForSkill(
        head.skill_id, this.versionTtlSeconds, this.maxNonHeadVersions,
      ).catch(() => { /* fire-and-forget */ });
      return result;
    } catch (e) {
      toCoreError(e);
    }
  }

  async delete(input: DeleteInput): Promise<{ skill_id: string; archived: boolean }> {
    try {
      const head = await this.store.getHeadIncludingArchived(input.skill_id, input.team_id);
      if (this.store.deleteWithReceipt && this.store.getDeletionReceipt) {
        const retired = head ? null : await this.store.getDeletionReceipt(input.skill_id, input.team_id);
        if (!head && !retired) throw new SkillCoreError("SKILL_NOT_FOUND");
        const teamId = head?.team_id ?? retired!.scope.team_id;
        const ownerId = head?.owner_agent_id ?? retired!.owner_agent_id;
        if (input.team_id && teamId !== input.team_id) throw new SkillCoreError("SKILL_NOT_FOUND");
        if (input.agent_id && ownerId !== input.agent_id) throw new SkillCoreError("SKILL_NOT_OWNER");
        const scope = { skill_id: input.skill_id, team_id: teamId };
        const expected = head ? { row_id: head.row_id, version: head.version, mutation_id: head.mutation_id ?? `legacy:${head.row_id}`, status: head.status } : retired!.original_head;
        const versionDirectory = (version: number) => this.resources.versionDir(input.skill_id, version);
        const result = await this.store.deleteWithReceipt({ scope, owner_agent_id: ownerId, expected_head: expected, versionDirectory,
          ...(head ? { previous_head: head } : {}) }, async (receipt, guard) => {
          if (receipt.scope.skill_id !== scope.skill_id || receipt.scope.team_id !== teamId || receipt.owner_agent_id !== ownerId) {
            throw new SkillCoreError("SKILL_NOT_OWNER", "cleanup receipt identity changed");
          }
          assertSkillDeletionTargets(scope, receipt.targets, versionDirectory);
          // The durable target list survives DB-row deletion and partial storage
          // cleanup. Directory removal is idempotent and must propagate failures.
          const directories = new Set(receipt.targets.map(target => target.storage_dir).filter(Boolean));
          for (const directory of directories) {
            await guard();
            await this.versioning.removeVersionDirectory(directory);
          }
          await guard();
          await this.onSkillArchived?.({ skill_id: input.skill_id, team_id: teamId });
          await guard();
        });
        if (result.completed_now) {
          // Best-effort existing metric callback, not crash-exactly-once. A
          // completed receipt prevents duplicate decrements on normal retries.
          try { this.versioning.reportDeletedVersions(result.receipt.targets.length); } catch { /* metric delivery is not the deletion authority */ }
        }
        return { skill_id: input.skill_id, archived: true };
      }

      // Keep the pre-existing local SQLite path outside the remote coordinator.
      if (input.team_id) assertTeamMatchWrap(head, input.team_id);
      if (!head) throw new SkillCoreError("SKILL_NOT_FOUND");
      if (input.agent_id) assertOwnerWrap(head, input.agent_id, input.team_id);
      const deleted = await this.versioning.deleteSkill(input.skill_id, input.team_id);
      if (deleted > 0 && this.onSkillArchived) {
        try { await this.onSkillArchived({ skill_id: input.skill_id, team_id: input.team_id }); } catch { /* legacy best-effort hook */ }
      }
      return { skill_id: input.skill_id, archived: deleted > 0 };
    } catch (error) { toCoreError(error); }
  }

  async writeFiles(input: WriteFilesInput): Promise<Skill> {
    const head = await this.requireHead(input.skill_id, input.team_id);
    if (input.agent_id) assertOwnerWrap(head, input.agent_id, input.team_id);
    assertVersionFreshWrap(head, input.expected_version);

    try {
      const result = await this.versioning.appendNextVersion(head, this.ctxOf(input), {
        content: head.content,
        name: head.name,
        description: head.description,
        resourcesToWrite: input.files,
      });
      void this.versioning.cleanupExpiredVersionsForSkill(
        head.skill_id, this.versionTtlSeconds, this.maxNonHeadVersions,
      ).catch(() => { /* fire-and-forget */ });
      return result;
    } catch (e) {
      toCoreError(e);
    }
  }

  async removeFiles(input: RemoveFilesInput): Promise<Skill> {
    const head = await this.requireHead(input.skill_id, input.team_id);
    if (input.agent_id) assertOwnerWrap(head, input.agent_id, input.team_id);
    assertVersionFreshWrap(head, input.expected_version);

    // 过滤出真实存在于 head manifest 中的 path（避免无效的资源变更触发空 v+1）
    const manifestPaths = new Set(head.manifest.map((m) => m.path));
    const toRemove = input.paths.filter((p) => manifestPaths.has(p));

    if (toRemove.length === 0) {
      return head; // 幂等
    }

    try {
      const result = await this.versioning.appendNextVersion(head, this.ctxOf(input), {
        content: head.content,
        name: head.name,
        description: head.description,
        resourcesToRemove: toRemove,
      });
      void this.versioning.cleanupExpiredVersionsForSkill(
        head.skill_id, this.versionTtlSeconds, this.maxNonHeadVersions,
      ).catch(() => { /* fire-and-forget */ });
      return result;
    } catch (e) {
      toCoreError(e);
    }
  }

  // ───────────────────────────────────────────────────────────────────
  //  READ actions
  // ───────────────────────────────────────────────────────────────────

  async get(input: GetInput): Promise<Skill> {
    if (typeof input.version === "number") {
      // 指定版本查询：先确认 skill 存在（通过 head），再查指定版本
      const head = await this.store.getHead(input.skill_id, input.team_id);
      if (input.team_id) assertTeamMatchWrap(head, input.team_id);
      if (!head) throw new SkillCoreError("SKILL_NOT_FOUND");
      const row = await this.store.getByVersion(input.skill_id, input.version, input.team_id);
      if (!row) {
        throw new SkillCoreError(
          "SKILL_NOT_FOUND",
          `version ${input.version} not found (may have been GC'd); current head is v${head.version}`,
        );
      }
      this.assertVersionNotExpired(row, head.version);
      // 读时自愈：即使拿的是历史版本，也用 head 触发（asset 只认 skill_id）
      this.notifyAccessed(head);
      return row;
    }
    // 不传 version → 返回最新 head
    const row = await this.store.getHead(input.skill_id, input.team_id);
    if (input.team_id) assertTeamMatchWrap(row, input.team_id);
    if (!row) throw new SkillCoreError("SKILL_NOT_FOUND");
    this.notifyAccessed(row);
    return row;
  }

  async list(input: ListInput): Promise<{ items: Skill[]; total: number }> {
    const opts: ListSkillsOptions = {
      team_id: input.team_id,
      owner_agent_id: input.filters?.owner_agent_id ?? input.agent_id,
      // user_id is an audit column (who wrote the skill), NOT an ownership filter.
      // When team_id is present, skills are team-shared — filtering by user_id
      // would exclude skills written by other team members.
      // Only apply user_id filter when there is no team_id (personal scope).
      user_id: input.team_id ? undefined : input.user_id,
      // task_id 与 user_id 同性质，是写审计字段（记 skill 首次落库时的对话上下文），
      // 不参与"哪些 skill 可用"的检索。传了会造成抽取器每次新对话（新 task_id）
      // 都看不到已有 skill → LLM 走 skill_create → 撞 SKILL_NAME_DUPLICATE →
      // 加后缀 (foo-v2, foo-v3, …) 产生大量同族 skill_id。
      // Store 层保留按 task_id 过滤的能力（供审计接口显式使用）。
      task_id: undefined,
      name_prefix: input.filters?.name_prefix,
      status: input.filters?.status,
      limit: input.pagination?.limit,
      offset: input.pagination?.offset,
    };
    return this.store.listSkills(opts);
  }

  async search(input: SearchInput): Promise<SkillSearchResult[]> {
    const opts: SearchSkillsOptions = {
      team_id: input.team_id,
      query: input.query,
      topK: input.top_k,
      mode: input.mode,
      agent_id: input.agent_id,
      // Same rationale as list(): task_id is audit-only, not a read filter.
      // See list() 上的详细注释。
      task_id: undefined,
      // Same rationale as list(): user_id is audit-only, not a read filter
      // when team-scoped. Skills are team-shared assets.
      user_id: input.team_id ? undefined : input.user_id,
    };
    return this.store.searchSkills(opts);
  }

  async listVersions(input: ListVersionsInput): Promise<{
    items: Array<Skill & { is_expired: boolean }>;
    total: number;
  }> {
    const items = await this.store.listVersions(input.skill_id, input.team_id, {
      limit: input.pagination?.limit,
      offset: input.pagination?.offset,
    });
    const total = await this.store.countVersions(input.skill_id, input.team_id);
    return {
      items: items.map((s) => ({ ...s, is_expired: this.isVersionExpired(s) })),
      total,
    };
  }

  async readFile(input: ReadFileInput): Promise<{
    path: string; content: string; encoding: "utf-8" | "base64";
    size_bytes: number; mime_type: string; version: number;
  }> {
    const head = await this.store.getHead(input.skill_id, input.team_id);
    if (input.team_id) assertTeamMatchWrap(head, input.team_id);
    if (!head) throw new SkillCoreError("SKILL_NOT_FOUND");
    const ver = input.version ?? head.version;
    // 校验 path 是否在该版本的 manifest 中（如果是 head 直接看 head.manifest，否则查 by version）
    const target = typeof input.version === "number" && input.version !== head.version
      ? await this.store.getByVersion(input.skill_id, input.version, input.team_id)
      : head;
    if (!target) {
      // head 存在但指定版本查不到 → 版本已被 GC，不是 skill 不存在
      throw new SkillCoreError(
        "STORAGE_NOT_FOUND",
        `version ${input.version} not found (may have been GC'd); current head is v${head.version}`,
      );
    }
    // TTL 检查：指定旧版本资源时拦截
    if (typeof input.version === "number" && input.version !== head.version) {
      this.assertVersionNotExpired(target, head.version);
    }
    const exists = target.manifest.some((m) => m.path === input.path);
    if (!exists) throw new SkillCoreError("SKILL_NOT_FOUND", `path ${input.path} not in manifest of v${ver}`);

    const r = await this.resources.readResource(input.skill_id, ver, input.path, input.encoding ?? "utf-8", target.storage_dir || undefined);
    if (!r) throw new SkillCoreError("STORAGE_NOT_FOUND", "version directory missing (may be GC'd)");
    this.notifyAccessed(head);
    return {
      path: r.path,
      content: r.content,
      encoding: r.encoding,
      size_bytes: r.size_bytes,
      mime_type: r.mime_type,
      version: ver,
    };
  }

  async exportSkill(input: ExportInput): Promise<{
    zip_base64: string;
    filename: string;
    name: string;
    version: number;
    file_count: number;
    total_bytes: number;
    warnings: string[];
  }> {
    // 1. 取目标版本
    const head = await this.store.getHead(input.skill_id, input.team_id);
    if (input.team_id) assertTeamMatchWrap(head, input.team_id);
    if (!head) throw new SkillCoreError("SKILL_NOT_FOUND");

    let target: Skill;
    if (typeof input.version === "number" && input.version !== head.version) {
      const byVersion = await this.store.getByVersion(input.skill_id, input.version, input.team_id);
      if (!byVersion) {
        throw new SkillCoreError(
          "SKILL_NOT_FOUND",
          `version ${input.version} not found`,
        );
      }
      target = byVersion;
      this.assertVersionNotExpired(target, head.version);
    } else {
      target = head;
    }

    // 2. 读 SKILL.md 内容（DB 权威源）
    const content = target.content;

    // 3. 读资源文件
    const warnings: string[] = [];
    const resources: Array<{
      path: string; content: string; encoding: "base64"; is_executable: boolean;
    }> = [];

    for (const entry of target.manifest) {
      const r = await this.resources.readResource(
        input.skill_id, target.version, entry.path, "base64", target.storage_dir || undefined,
      );
      if (!r) {
        warnings.push(`${entry.path}: missing in storage, skipped`);
        continue;
      }
      resources.push({
        path: entry.path,
        content: r.content,
        encoding: "base64",
        is_executable: entry.is_executable,
      });
    }

    // 4. 打包 zip
    const zipBuf = buildZip(target.name, content, resources);

    // 5. 上限防护
    if (zipBuf.length > this.resources.getMaxSkillTotalBytes()) {
      throw new SkillCoreError(
        "SKILL_EXPORT_TOO_LARGE",
        `exported zip ${zipBuf.length} bytes exceeds max ${this.resources.getMaxSkillTotalBytes()} bytes`,
      );
    }

    return {
      zip_base64: zipBuf.toString("base64"),
      filename: `${target.name}.zip`,
      name: target.name,
      version: target.version,
      file_count: resources.length,
      total_bytes: zipBuf.length,
      warnings,
    };
  }

  // ───────────────────────────────────────────────────────────────────
  //  helpers
  // ───────────────────────────────────────────────────────────────────

  private packageContext(input: IdFields & { skill_id: string }) {
    if (typeof input.skill_id !== "string" || !/^skl-[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(input.skill_id)) {
      throw new SkillCoreError("SKILL_MUTATION_CONFLICT", "invalid stable skill_id");
    }
    for (const value of [input.team_id, input.agent_id, input.user_id, input.task_id]) {
      if (value !== undefined && (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 256 || /[\x00-\x1f]/.test(value))) {
        throw new SkillCoreError("SKILL_MUTATION_CONFLICT", "invalid package identity");
      }
    }
    return { team_id: input.team_id ?? "default", agent_id: input.agent_id ?? "default",
      user_id: input.user_id ?? "default", task_id: input.task_id ?? "default" };
  }

  private assertMutationId(id: string): void {
    if (typeof id !== "string" || !id.trim() || id !== id.trim() || id.length > 256 || /[\x00-\x1f]/.test(id)) {
      throw new SkillCoreError("SKILL_MUTATION_CONFLICT", "invalid package mutation_id");
    }
  }

  private assertPackageVersion(version: number): void {
    if (!Number.isSafeInteger(version) || version < 1) throw new SkillCoreError("SKILL_VERSION_STALE", "expected_version must be a positive safe integer");
  }

  private async requirePackageHead(skillId: string, ctx: { team_id: string; agent_id: string }): Promise<Skill> {
    const head = await this.requireHead(skillId, ctx.team_id);
    assertOwnerWrap(head, ctx.agent_id, ctx.team_id);
    this.assertPackageAllowed(head.content, this.packageMetadata(head));
    return head;
  }

  private packageMetadata(skill: Skill): Record<string, unknown> {
    let metadata: unknown;
    try { metadata = JSON.parse(skill.metadata_json); }
    catch { throw new SkillCoreError("SKILL_MUTATION_CONFLICT", "invalid package metadata JSON"); }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new SkillCoreError("SKILL_MUTATION_CONFLICT", "package metadata must be an object");
    }
    return metadata as Record<string, unknown>;
  }

  private assertPackageAllowed(content: string, metadata: Record<string, unknown>): void {
    try {
      const file = parseSkillFile(content);
      validateSkillFile({ ...file, body: "" });
    } catch (error) {
      throw new SkillCoreError("SKILL_FRONTMATTER_INVALID", (error as Error).message);
    }
    // parseSkillFile intentionally projects only known fields. Parse the same
    // YAML fence to inspect guards without mistaking quoted strings/body text for booleans.
    const lines = content.replace(/\r\n?/g, "\n").split("\n");
    const end = lines.findIndex((line, index) => index > 0 && line === "---");
    const frontmatter = parseYaml(lines.slice(1, end).join("\n")) as Record<string, unknown>;
    const guarded = (value: unknown): boolean => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const flags = value as Record<string, unknown>;
      return flags.protected === true || flags.pinned === true || flags.external_managed === true ||
        flags.managed_by === "external" || flags.source === "external" || flags.source === "external-managed";
    };
    if (guarded(metadata) || guarded(metadata.source) || guarded(frontmatter) || guarded(frontmatter.metadata) || guarded(frontmatter.source)) {
      throw new SkillCoreError("SKILL_PROTECTED", "protected, pinned or externally managed packages cannot be semantically changed");
    }
  }

  private packageResources(payloads: SkillResourcePayload[]): SkillResourcePayload[] {
    if (!Array.isArray(payloads)) throw new SkillCoreError("INVALID_PATH", "resources must be a complete array");
    const seen = new Set<string>();
    for (const payload of payloads) {
      // Reject aliases such as a//b, ./a and backslashes: complete sets must have
      // one canonical name per physical resource on both local and object storage.
      if (!payload || typeof payload.path !== "string" || !payload.path || payload.path.includes("\\") || payload.path.includes("\0") ||
          payload.path.split("/").some(part => !part || part === "." || part === "..") || seen.has(payload.path)) {
        throw new SkillCoreError("INVALID_PATH", "package resource paths must be unique relative POSIX paths");
      }
      if (typeof payload.content !== "string" || (payload.encoding !== "utf-8" && payload.encoding !== "base64")) {
        throw new SkillCoreError("RESOURCE_INTEGRITY_ERROR", "invalid package resource content or encoding");
      }
      seen.add(payload.path);
    }
    return [...payloads].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }

  private parseAndValidate(raw: string) {
    let file;
    try {
      file = parseSkillFile(raw);
      validateSkillFile(file);
    } catch (e) {
      // Parse / 长度 / regex 失败 → 42203（设计 §3.6）
      throw new SkillCoreError("SKILL_FRONTMATTER_INVALID", (e as Error).message);
    }
    return file;
  }

  private async requireHead(skillId: string, teamId?: string): Promise<Skill> {
    const head = await this.store.getHead(skillId, teamId);
    if (teamId) assertTeamMatchWrap(head, teamId);
    if (!head) throw new SkillCoreError("SKILL_NOT_FOUND");
    return head;
  }

  private ctxOf(input: { user_id?: string; team_id?: string; agent_id?: string; task_id?: string }) {
    return {
      user_id: input.user_id,
      team_id: input.team_id,
      agent_id: input.agent_id,
      task_id: input.task_id,
    };
  }

  // ── TTL helpers ──

  /** 判断非 head 版本是否过期。head 永不过期；ttlSeconds=0 关闭。 */
  private isVersionExpired(skill: Skill): boolean {
    if (skill.is_head) return false;
    if (!this.versionTtlSeconds) return false;
    return this.now() - skill.created_at_ms > this.versionTtlSeconds * 1000;
  }

  private assertVersionNotExpired(skill: Skill, headVersion: number): void {
    if (!this.isVersionExpired(skill)) return;
    const ageDays = ((this.now() - skill.created_at_ms) / 86400000).toFixed(1);
    const ttlDays = this.versionTtlSeconds / 86400;
    throw new SkillCoreError(
      "SKILL_VERSION_EXPIRED",
      `Skill '${skill.name}' version v${skill.version} has expired ` +
      `(created ${ageDays} days ago, TTL is ${ttlDays} days). ` +
      `Please use the latest version v${headVersion}.`,
    );
  }
}

// ═════════════════════════════════════════════════════════════════════
//  内部小工具
// ═════════════════════════════════════════════════════════════════════

function assertOwnerWrap(head: Skill, agentId: string, teamId?: string): void {
  try { assertOwner(head, agentId, teamId); }
  catch (e) {
    if (e instanceof SkillPermissionError) throw new SkillCoreError(e.code as SkillCoreErrorCode, e.message);
    throw e;
  }
}

function assertTeamMatchWrap(row: Skill | null, teamId: string): asserts row is Skill {
  try { assertTeamMatch(row, teamId); }
  catch (e) {
    if (e instanceof SkillPermissionError) throw new SkillCoreError(e.code as SkillCoreErrorCode, e.message);
    throw e;
  }
}

function assertVersionFreshWrap(head: Skill, expected: number): void {
  try { assertVersionFresh(head, expected); }
  catch (e) {
    if (e instanceof SkillPermissionError) throw new SkillCoreError(e.code as SkillCoreErrorCode, e.message);
    throw e;
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

function splitJoin(s: string, find: string, replace: string): string {
  return s.split(find).join(replace);
}

// ═════════════════════════════════════════════════════════════════════
//  zip 打包
// ═════════════════════════════════════════════════════════════════════

function buildZip(
  name: string,
  skillMdContent: string,
  resources: Array<{ path: string; content: string; encoding: "base64"; is_executable: boolean }>,
): Buffer {
  const files: Record<string, [Uint8Array, { level?: number; mtime?: Date; mode?: number }?]> = {};

  // 1. SKILL.md
  files[`${name}/SKILL.md`] = [strToU8(skillMdContent)];

  // 2. 资源文件（直接放在 name/ 下，与导入源目录结构一致）
  for (const r of resources) {
    const key = `${name}/${r.path}`;
    const buf = r.encoding === "base64"
      ? Uint8Array.from(Buffer.from(r.content, "base64"))
      : strToU8(r.content);
    files[key] = [buf, {
      mode: r.is_executable ? 0o755 : 0o644,
    }];
  }

  // fflate 的 Zippable 类型对 value 的约束与我们的 Record 不完全一致，
  // 但运行时完全兼容（Uint8Array + opts tuple 就是合法的 ZippableFile）。
  const zipped = zipSync(files as unknown as Parameters<typeof zipSync>[0]);
  return Buffer.from(zipped);
}
