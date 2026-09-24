/**
 * GitCredentialStore — 托管 git 凭证（team 级共享）。
 *
 * 与 IKnowledgeStore 解耦：一张小表 + 一套「加密存储 / 解密取用」的边界，和
 * llm-binding-store.ts 的定位一致。但比它多两条硬约束：
 *
 * 1. **所有访问路径强制带 service_id + team_id。**
 *    KS 的 `service_id` 是自报的、鉴权只有一把全局 service key，所以 KS 层面
 *    唯一能做的收敛就是「同一个 service 内也按 team 限定」。任何 id-only 的
 *    访问器都会让同 service 的另一个 team 读到凭证元数据（host / name /
 *    created_by），因此这里不提供 id-only 方法。
 *
 * 2. **resolveMaterial() 按 host 严格相等匹配，不做通配。**
 *    `/test` 与 build 都会拿着用户给的 repo_url 来取材料。若允许 host 通配或
 *    只用 credential_id 取用，任何持 service key 的人都能让服务端把团队 token
 *    以 `Authorization: Basic` 发到自己的主机 —— 等于把「托管密钥」变成
 *    「SSRF 回显窃取」。host 绑定是这条攻击链的唯一断点。
 *
 * 密钥本体的加密/解密全部走 crypto/secret-box.ts；本模块只负责编排与事务。
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { knowledgeGitCredential, knowledgeGitCredentialAudit } from "../db/schema.js";
import { decryptSecret, deriveSecretKey, encryptSecret, fingerprintSecret } from "../crypto/secret-box.js";
import { normalizeHost, parseGitUrl } from "../source-fetcher/git-url.js";
import type { GitAuthMaterial } from "../source-fetcher/git-auth.js";
import type {
  CreateGitCredentialInput,
  CredentialAuditAction,
  CredentialAuditRow,
  GitCredentialKind,
  GitCredentialRow,
} from "./types.js";

/** 同一 (service, team) 下重名。路由层转 409。 */
export class DuplicateCredentialNameError extends Error {
  constructor(name: string) {
    super(`git credential name already exists in this team: ${name}`);
    this.name = "DuplicateCredentialNameError";
  }
}

export interface GitCredentialStoreOptions {
  db: Db;
  /** KNOWLEDGE_SECRET_KEY；为空则读写凭证都会抛 SecretKeyError。 */
  secretKey: string;
}

export interface IGitCredentialStore {
  create(input: CreateGitCredentialInput): GitCredentialRow;
  list(serviceId: string, teamId: string): GitCredentialRow[];
  get(serviceId: string, teamId: string, credentialId: string): GitCredentialRow | null;
  delete(serviceId: string, teamId: string, credentialIds: string[]): { deleted_ids: string[]; failed: Array<{ id: string; reason: string }> };
  /**
   * 取出可直接交给 git 的明文材料。
   * @returns null = 该 team 下没有匹配该 host 的凭证（按匿名访问继续）
   * @throws SecretKeyError / 解密失败 —— 有凭证但读不出来必须显式失败，不能静默降级为匿名。
   */
  resolveMaterial(serviceId: string, teamId: string, repoUrl: string, credentialId?: string | null): GitAuthMaterial | null;
  /** 该 host 是否已存在可用凭证（供路由做 host 绑定校验）。 */
  findByHost(serviceId: string, teamId: string, host: string): GitCredentialRow | null;
  countForService(serviceId: string): number;
  appendAudit(input: {
    service_id?: string | null;
    credential_id: string;
    action: CredentialAuditAction;
    user_id?: string | null;
    detail?: string | null;
  }): void;
  listAudit(serviceId: string, credentialId: string, limit?: number): CredentialAuditRow[];
}

export function createGitCredentialStore(opts: GitCredentialStoreOptions): IGitCredentialStore {
  const { db } = opts;

  /** 惰性派生主密钥：未配置时只在真正需要加解密的那一刻才报错，不影响服务启动时的公开仓库路径。 */
  let cachedKey: Buffer | null = null;
  function key(): Buffer {
    if (!cachedKey) cachedKey = deriveSecretKey(opts.secretKey);
    return cachedKey;
  }

  const store: IGitCredentialStore = {
    create(input: CreateGitCredentialInput): GitCredentialRow {
      const now = new Date().toISOString();
      const secret = key(); // 先确保主密钥可用，避免插入到一半才失败
      const existing = db
        .select({ id: knowledgeGitCredential.credentialId })
        .from(knowledgeGitCredential)
        .where(
          and(
            eq(knowledgeGitCredential.serviceId, input.service_id),
            eq(knowledgeGitCredential.teamId, input.team_id),
            eq(knowledgeGitCredential.name, input.name),
            isNull(knowledgeGitCredential.deletedAt),
          ),
        )
        .all();
      if (existing.length > 0) throw new DuplicateCredentialNameError(input.name);

      db.insert(knowledgeGitCredential)
        .values({
          credentialId: input.credential_id,
          serviceId: input.service_id,
          teamId: input.team_id,
          name: input.name,
          kind: input.kind,
          host: normalizeHost(input.host),
          username: input.username ?? null,
          // AAD = credential_id：把密文绑死在行主键上，防止有 DB 写权限的人
          // 把 A 行的密文搬到 B 行以绕过 host 绑定。
          secretEnc: encryptSecret(input.secret, secret, input.credential_id),
          fingerprint: fingerprintSecret(input.secret, secret),
          createdBy: input.created_by ?? null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        })
        .run();

      return store.get(input.service_id, input.team_id, input.credential_id)!;
    },

    list(serviceId: string, teamId: string): GitCredentialRow[] {
      return db
        .select()
        .from(knowledgeGitCredential)
        .where(
          and(
            eq(knowledgeGitCredential.serviceId, serviceId),
            eq(knowledgeGitCredential.teamId, teamId),
            isNull(knowledgeGitCredential.deletedAt),
          ),
        )
        .orderBy(desc(knowledgeGitCredential.updatedAt))
        .all()
        .map(toRow);
    },

    get(serviceId: string, teamId: string, credentialId: string): GitCredentialRow | null {
      const row = db
        .select()
        .from(knowledgeGitCredential)
        .where(
          and(
            eq(knowledgeGitCredential.serviceId, serviceId),
            eq(knowledgeGitCredential.teamId, teamId),
            eq(knowledgeGitCredential.credentialId, credentialId),
            isNull(knowledgeGitCredential.deletedAt),
          ),
        )
        .all()[0];
      return row ? toRow(row) : null;
    },

    findByHost(serviceId: string, teamId: string, host: string): GitCredentialRow | null {
      const normalized = normalizeHost(host);
      const row = db
        .select()
        .from(knowledgeGitCredential)
        .where(
          and(
            eq(knowledgeGitCredential.serviceId, serviceId),
            eq(knowledgeGitCredential.teamId, teamId),
            eq(knowledgeGitCredential.host, normalized),
            isNull(knowledgeGitCredential.deletedAt),
          ),
        )
        .all()[0];
      return row ? toRow(row) : null;
    },

    delete(serviceId: string, teamId: string, credentialIds: string[]) {
      const result: { deleted_ids: string[]; failed: Array<{ id: string; reason: string }> } = {
        deleted_ids: [],
        failed: [],
      };
      const now = new Date().toISOString();

      for (const id of credentialIds) {
        const row = store.get(serviceId, teamId, id);
        if (!row) {
          result.failed.push({ id, reason: "not found" });
          continue;
        }
        // 软删：留痕，且让 pending/processing 中的 build 在 resolveMaterial
        // 时明确失败（而不是拿到一个已消失的行）。
        db.update(knowledgeGitCredential)
          .set({ deletedAt: now, updatedAt: now })
          .where(
            and(
              eq(knowledgeGitCredential.serviceId, serviceId),
              eq(knowledgeGitCredential.teamId, teamId),
              eq(knowledgeGitCredential.credentialId, id),
            ),
          )
          .run();
        result.deleted_ids.push(id);
      }

      return result;
    },

    resolveMaterial(
      serviceId: string,
      teamId: string,
      repoUrl: string,
      credentialId?: string | null,
    ): GitAuthMaterial | null {
      const parsed = parseGitUrl(repoUrl);
      if (!parsed) return null;

      const row = credentialId
        ? store.get(serviceId, teamId, credentialId)
        : store.findByHost(serviceId, teamId, parsed.host);

      if (!row) return null;

      // host 强绑定：即使调用方显式指定了 credential_id，也必须与 repo_url 一致。
      if (row.host !== parsed.host) return null;

      return materialFrom(row, decrypt(row, key()));
    },

    countForService(serviceId: string): number {
      const rows = db
        .select({ n: sql<number>`count(*)` })
        .from(knowledgeGitCredential)
        .where(and(eq(knowledgeGitCredential.serviceId, serviceId), isNull(knowledgeGitCredential.deletedAt)))
        .all();
      return Number(rows[0]?.n ?? 0);
    },

    appendAudit(input) {
      try {
        db.insert(knowledgeGitCredentialAudit)
          .values({
            credentialId: input.credential_id,
            serviceId: input.service_id ?? null,
            action: input.action,
            userId: input.user_id ?? null,
            detail: input.detail ?? null,
            createdAt: new Date().toISOString(),
          })
          .run();
      } catch {
        // 审计失败不阻断主流程（与 code-graph 审计一致）
      }
    },

    listAudit(serviceId: string, credentialId: string, limit = 50): CredentialAuditRow[] {
      return db
        .select()
        .from(knowledgeGitCredentialAudit)
        .where(
          and(
            eq(knowledgeGitCredentialAudit.serviceId, serviceId),
            eq(knowledgeGitCredentialAudit.credentialId, credentialId),
          ),
        )
        .orderBy(desc(knowledgeGitCredentialAudit.id))
        .limit(limit)
        .all()
        .map((r) => ({
          id: r.id,
          credential_id: r.credentialId,
          service_id: r.serviceId ?? null,
          action: r.action as CredentialAuditAction,
          user_id: r.userId ?? null,
          detail: r.detail ?? null,
          created_at: r.createdAt,
        }));
    },
  };

  return store;

  // ── helpers ──

  function decrypt(row: GitCredentialRow, secret: Buffer): string {
    const enc = db
      .select({ secretEnc: knowledgeGitCredential.secretEnc })
      .from(knowledgeGitCredential)
      .where(eq(knowledgeGitCredential.credentialId, row.credential_id))
      .all()[0]?.secretEnc;

    if (!enc) throw new Error(`git credential ${row.credential_id} has no stored secret`);
    return decryptSecret(enc, secret, row.credential_id);
  }
}

function materialFrom(row: GitCredentialRow, plaintext: string): GitAuthMaterial {
  return row.kind === "ssh_key"
    ? { kind: "ssh_key", privateKey: plaintext }
    : { kind: "https_token", username: row.username ?? undefined, token: plaintext };
}

function toRow(r: typeof knowledgeGitCredential.$inferSelect): GitCredentialRow {
  return {
    credential_id: r.credentialId,
    service_id: r.serviceId,
    team_id: r.teamId,
    name: r.name,
    kind: (r.kind === "ssh_key" ? "ssh_key" : "https_token") as GitCredentialKind,
    host: r.host,
    username: r.username ?? null,
    fingerprint: r.fingerprint,
    created_by: r.createdBy ?? null,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    deleted_at: r.deletedAt ?? null,
  };
}
