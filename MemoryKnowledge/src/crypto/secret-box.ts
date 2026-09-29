/**
 * SecretBox — 托管凭证的静态加密。
 *
 * 设计取舍：
 *   - **算法**：AES-256-GCM（认证加密），与项目既有先例
 *     `MemoryPanel/src/panel/auth/identity-store.ts` 保持一致。
 *   - **密钥派生**：主密钥直接 `sha256(KNOWLEDGE_SECRET_KEY)` 取 32 字节。
 *     这里刻意不用慢 KDF / 加盐：主密钥要求是 `openssl rand -base64 32` 级别的
 *     高熵随机值，盐只对低熵口令有意义。代价是**必须在 loadSecretKey() 里卡住
 *     长度**，否则用户拿一句口令当密钥就会得到一个静默弱化的实现。
 *   - **AAD = credential_id**：把密文绑定到行主键。否则有 DB 写权限的人可以把
 *     A 行的密文搬到 B 行，凭 `host` 校验绕过「凭证只对声明主机生效」的约束。
 *   - **版本前缀 `v1.`**：为将来换算法/KDF 留迁移路径。密文里不带版本号的话，
 *     一旦需要轮换就只能全量重加密或永久锁死。
 */

import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes } from "node:crypto";

/** 密文格式版本前缀。 */
export const SECRET_FORMAT_VERSION = "v1";

/** 主密钥最小长度（字节）。 */
export const MIN_SECRET_KEY_BYTES = 32;

const IV_BYTES = 12;

export class SecretKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretKeyError";
  }
}

/**
 * 校验并返回主密钥的派生 key。
 *
 * @throws SecretKeyError 密钥缺失或强度不足
 */
export function deriveSecretKey(secretKey: string | undefined | null, source = "KNOWLEDGE_SECRET_KEY"): Buffer {
  const raw = (secretKey ?? "").trim();
  if (!raw) {
    throw new SecretKeyError(
      `${source} is not configured. Managed git credentials cannot be read or written without it. ` +
        `Generate one with: openssl rand -base64 32`,
    );
  }

  // 支持 base64 / base64url / 原始字符串三种写法，取解码后更长的那个口径判断强度。
  const decoded = tryDecode(raw);
  const material = decoded && decoded.length > raw.length ? decoded : Buffer.from(raw, "utf8");

  if (material.length < MIN_SECRET_KEY_BYTES) {
    throw new SecretKeyError(
      `${source} is too weak: ${material.length} bytes of entropy-bearing material, ` +
        `need at least ${MIN_SECRET_KEY_BYTES}. Generate one with: openssl rand -base64 32`,
    );
  }

  return createHash("sha256").update(material).digest();
}

function tryDecode(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/_=-]+$/.test(value)) return null;
  try {
    const buf = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

/**
 * 加密一段明文，产出 `v1.<iv>.<tag>.<ciphertext>`（各段 base64url）。
 *
 * @param plain 明文（HTTPS token 或 SSH 私钥）
 * @param key 由 `deriveSecretKey()` 产出的 32 字节 key
 * @param aad 附加认证数据；调用方应传 credential_id
 */
export function encryptSecret(plain: string, key: Buffer, aad?: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));

  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    SECRET_FORMAT_VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * 解密 `encryptSecret()` 的产物。
 *
 * @throws Error 格式非法、AAD 不匹配或密钥错误（GCM 认证失败）
 */
export function decryptSecret(payload: string, key: Buffer, aad?: string): string {
  const parts = String(payload ?? "").split(".");
  if (parts.length !== 4 || parts[0] !== SECRET_FORMAT_VERSION) {
    throw new Error(`unsupported encrypted secret format: ${String(payload).slice(0, 8)}…`);
  }

  const [, ivText, tagText, ciphertextText] = parts;
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * 凭证指纹：HMAC-SHA256(主密钥, 明文) 前 16 位 hex。
 *
 * 用 HMAC 而不是裸 `sha256(明文)`：裸哈希在 DB 泄漏后可以被拿来离线枚举
 * （token 往往有可猜的形态），且不持有主密钥也能算出，无法作为「同一凭证」的
 * 可信判据。展示与查重都够用，但不能反推。
 */
export function fingerprintSecret(plain: string, key: Buffer): string {
  return createHmac("sha256", key).update(plain, "utf8").digest("hex").slice(0, 16);
}
