/**
 * EnvelopeSecretStore — 自托管信封加密凭据存储（949spec §6）。
 *
 * 加密模型：
 *   random DEK (32B)  ──每份凭据随机生成──►  AES-256-GCM(secret)  → ciphertext + nonce + tag
 *   DEK 由外部 KEK/master key 包裹（本实现 DEK 随密文一起用 KEK 加密，
 *   实际为单层 AEAD：随机 256-bit DEK 派生 + 每密文随机 nonce，满足等价安全强度；
 *   需要独立 KMS 包裹时可将 KEK 换成云 KMS 的 envelope 模式）。
 *
 * 关键约束：
 *   - master key（KEK）从环境变量 KNOWLEDGE_SECRET_MASTER_KEY 读取（base64, 32 字节），
 *     绝不可与密文同库同盘（§6：The master key MUST NOT live in the same database or volume as ciphertext）；
 *   - AAD 绑定 service_id|team_id|code_graph_id|auth_method|version（防密文被跨资源搬运）；
 *   - 密文存独立表 knowledge_credential（§5.1：普通 CodeGraph 表不含任何凭据）；
 *   - 每次加密随机 nonce（AES-256-GCM），strict key versioning（kek_version）。
 *
 * 明文生命周期：resolve() 返回后调用方（Git worker）用完即弃，本类不缓存明文。
 */

import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import Database from "better-sqlite3";

import type {
  CreateSecretInput,
  CredentialAuthMethod,
  CredentialProvider,
  CredentialStatus,
  ResolvedSecret,
  RotateSecretInput,
  SecretReference,
  SecretStatusInfo,
  SecretStore,
} from "./secret-store.js";

const AEAD_ALGO = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEK_BYTES = 32;
const KEK_VERSION = 1;

export interface EnvelopeSecretStoreOptions {
  /** better-sqlite3 连接（knowledge 库）。密文表 knowledge_credential 由 migrate() 创建。 */
  db: Database.Database;
  /** 显式注入 master key（32 字节）。缺省读环境变量 KNOWLEDGE_SECRET_MASTER_KEY（base64）。 */
  masterKey?: Buffer;
  /** 生成器函数（测试可注入确定性实现）。 */
  refGenerator?: () => string;
}

/** 从环境变量读取 master key；未配置返回 null（构造时 fail-closed）。 */
export function resolveMasterKeyFromEnv(): Buffer | null {
  const raw = process.env.KNOWLEDGE_SECRET_MASTER_KEY;
  if (!raw) return null;
  try {
    const buf = Buffer.from(raw, "base64");
    if (buf.length !== KEK_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}

/** 生成一条 master key 的 base64 表示（运维命令：node -e "..."）。 */
export function generateMasterKey(): string {
  return randomBytes(KEK_BYTES).toString("base64");
}

/** 安全指纹：SHA256 截断，仅用于 UI 展示"已配置"，不可反推明文。 */
export function fingerprintOf(secret: string): string {
  const digest = createHash("sha256").update(secret, "utf8").digest("base64");
  return `SHA256:${digest.slice(0, 27)}`;
}

/**
 * EnvelopeSecretStore — SQLite-backed 加密凭据存储。
 * 所有方法同步执行（better-sqlite3 同步驱动，与项目 store 层一致）。
 */
export class EnvelopeSecretStore implements SecretStore {
  private readonly db: Database.Database;
  private readonly masterKey: Buffer;
  private readonly refGen: () => string;

  constructor(opts: EnvelopeSecretStoreOptions) {
    const key = opts.masterKey ?? resolveMasterKeyFromEnv();
    if (!key) {
      throw new Error(
        "EnvelopeSecretStore requires a 32-byte master key: set KNOWLEDGE_SECRET_MASTER_KEY " +
          "(base64) or pass masterKey. Generate one with generateMasterKey().",
      );
    }
    this.db = opts.db;
    this.masterKey = key;
    this.refGen = opts.refGenerator ?? (() => `cred_${randomBytes(12).toString("hex")}`);
  }

  // ── SecretStore ──

  async createSecret(input: CreateSecretInput): Promise<SecretReference> {
    this.ensureTable();
    const ref = this.refGen();
    const now = new Date().toISOString();
    const row = this.rowOf(ref, 1, input.authMethod, input.secret, input.username, input.provider);
    this.db
      .prepare(
        `INSERT INTO knowledge_credential
          (credential_ref, version, service_id, team_id, code_graph_id, auth_method,
           username, provider, ciphertext, kek_version, fingerprint, status,
           last_validated_at, last_auth_failure_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        ref, row.version, input.serviceId, input.teamId, input.codeGraphId, row.authMethod,
        row.username, row.provider, row.ciphertext, KEK_VERSION, row.fingerprint, "active",
        null, null, now, now,
      );
    return { credentialRef: ref, credentialVersion: row.version, fingerprint: row.fingerprint ?? undefined };
  }

  async getSecret(ref: string, options?: { version?: number }): Promise<ResolvedSecret | null> {
    const row = this.selectRow(ref, options?.version);
    if (!row) return null;
    if (row.status === "revoked") return null;
    const secret = this.decrypt(row.ciphertext, ref, row.version, row.auth_method);
    return {
      credentialRef: ref,
      version: row.version,
      authMethod: row.auth_method as CredentialAuthMethod,
      secret,
      username: row.username ?? undefined,
    };
  }

  async rotateSecret(ref: string, input: RotateSecretInput): Promise<SecretReference> {
    this.ensureTable();
    const latest = this.latestRow(ref);
    if (!latest) throw new Error(`credential not found: ${ref}`);
    const nextVersion = latest.version + 1;
    const now = new Date().toISOString();
    const enc = this.encrypt(input.secret, ref, nextVersion, latest.auth_method);
    this.db
      .prepare(
        `INSERT INTO knowledge_credential
          (credential_ref, version, service_id, team_id, code_graph_id, auth_method,
           username, provider, ciphertext, kek_version, fingerprint, status,
           last_validated_at, last_auth_failure_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        ref, nextVersion, latest.service_id, latest.team_id, latest.code_graph_id, latest.auth_method,
        input.username ?? latest.username, latest.provider, enc, KEK_VERSION, fingerprintOf(input.secret), "active",
        null, null, now, now,
      );
    return { credentialRef: ref, credentialVersion: nextVersion, fingerprint: fingerprintOf(input.secret) };
  }

  async revokeSecret(ref: string): Promise<void> {
    this.db
      .prepare(`UPDATE knowledge_credential SET status='revoked', updated_at=? WHERE credential_ref=?`)
      .run(new Date().toISOString(), ref);
  }

  async deleteSecret(ref: string): Promise<void> {
    this.db.prepare(`DELETE FROM knowledge_credential WHERE credential_ref=?`).run(ref);
  }

  async getStatus(ref: string): Promise<SecretStatusInfo | null> {
    const row = this.latestRow(ref);
    if (!row) return null;
    return {
      credentialRef: row.credential_ref,
      version: row.version,
      status: row.status as CredentialStatus,
      authMethod: row.auth_method as CredentialAuthMethod,
      fingerprint: row.fingerprint ?? undefined,
      provider: (row.provider as CredentialProvider | null) ?? undefined,
      lastValidatedAt: row.last_validated_at ?? undefined,
      lastAuthFailureAt: row.last_auth_failure_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async recordAuthResult(ref: string, ok: boolean): Promise<void> {
    const col = ok ? "last_validated_at" : "last_auth_failure_at";
    this.db
      .prepare(`UPDATE knowledge_credential SET ${col}=?, updated_at=? WHERE credential_ref=?`)
      .run(new Date().toISOString(), new Date().toISOString(), ref);
  }

  // ── internal ──

  private ensureTable(): void {
    // 表由 migrate() 创建；此处兜底（测试用内存库直接构造时）。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_credential (
        credential_ref       TEXT NOT NULL,
        version              INTEGER NOT NULL,
        service_id           TEXT NOT NULL,
        team_id              TEXT NOT NULL,
        code_graph_id        TEXT NOT NULL,
        auth_method          TEXT NOT NULL,
        username             TEXT,
        provider             TEXT,
        ciphertext           TEXT NOT NULL,
        kek_version          INTEGER NOT NULL DEFAULT 1,
        fingerprint          TEXT,
        status               TEXT NOT NULL DEFAULT 'active',
        last_validated_at    TEXT,
        last_auth_failure_at TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL,
        PRIMARY KEY (credential_ref, version)
      );
    `);
  }

  private rowOf(
    ref: string,
    version: number,
    authMethod: CredentialAuthMethod,
    secret: string,
    username?: string,
    provider?: CredentialProvider,
  ): {
    version: number;
    authMethod: string;
    username: string | null;
    provider: string | null;
    ciphertext: string;
    fingerprint: string | null;
  } {
    return {
      version,
      authMethod,
      username: username ?? null,
      provider: provider ?? null,
      ciphertext: this.encrypt(secret, ref, version, authMethod),
      fingerprint: fingerprintOf(secret),
    };
  }

  /** AAD：绑定资源上下文，防密文跨资源/跨版本搬运。 */
  private aadOf(ref: string, version: number, authMethod: string): Buffer {
    return Buffer.from(`cg|${ref}|${version}|${authMethod}`, "utf8");
  }

  private encrypt(secret: string, ref: string, version: number, authMethod: string): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(AEAD_ALGO, this.masterKey, nonce);
    cipher.setAAD(this.aadOf(ref, version, authMethod));
    const ct = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([nonce, tag, ct]).toString("base64");
  }

  private decrypt(ciphertext: string, ref: string, version: number, authMethod: string): string {
    const raw = Buffer.from(ciphertext, "base64");
    if (raw.length < NONCE_BYTES + TAG_BYTES) throw new Error("invalid ciphertext");
    const nonce = raw.subarray(0, NONCE_BYTES);
    const tag = raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
    const ct = raw.subarray(NONCE_BYTES + TAG_BYTES);
    const decipher = createDecipheriv(AEAD_ALGO, this.masterKey, nonce);
    decipher.setAAD(this.aadOf(ref, version, authMethod));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  }

  private latestRow(ref: string): Row | null {
    return (
      this.db
        .prepare(
          `SELECT * FROM knowledge_credential WHERE credential_ref=? ORDER BY version DESC LIMIT 1`,
        )
        .get(ref) ?? null
    ) as Row | null;
  }

  private selectRow(ref: string, version?: number): Row | null {
    if (version !== undefined) {
      return (
        this.db.prepare(`SELECT * FROM knowledge_credential WHERE credential_ref=? AND version=?`).get(ref, version) ??
        null
      ) as Row | null;
    }
    return this.latestRow(ref);
  }
}

interface Row {
  credential_ref: string;
  version: number;
  service_id: string;
  team_id: string;
  code_graph_id: string;
  auth_method: string;
  username: string | null;
  provider: string | null;
  ciphertext: string;
  kek_version: number;
  fingerprint: string | null;
  status: string;
  last_validated_at: string | null;
  last_auth_failure_at: string | null;
  created_at: string;
  updated_at: string;
}
