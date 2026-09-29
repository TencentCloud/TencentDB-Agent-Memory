import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  MIN_SECRET_KEY_BYTES,
  SecretKeyError,
  decryptSecret,
  deriveSecretKey,
  encryptSecret,
  fingerprintSecret,
} from "./secret-box.js";

const KEY = deriveSecretKey("a".repeat(48));

describe("deriveSecretKey", () => {
  it("产出 32 字节 key", () => {
    expect(KEY).toHaveLength(32);
  });

  it("拒绝缺失 / 空串（fail-closed，绝不静默降级）", () => {
    for (const bad of [undefined, null, "", "   "]) {
      expect(() => deriveSecretKey(bad as string | undefined)).toThrow(SecretKeyError);
    }
  });

  it("拒绝强度不足的短密钥", () => {
    expect(() => deriveSecretKey("short")).toThrow(/too weak/);
    expect(() => deriveSecretKey("x".repeat(MIN_SECRET_KEY_BYTES - 1))).toThrow(/too weak/);
  });

  it("恰好达到下限的密钥可用", () => {
    expect(() => deriveSecretKey("x".repeat(MIN_SECRET_KEY_BYTES))).not.toThrow();
  });

  it("错误信息里带生成方式（避免用户拿口令当密钥）", () => {
    try {
      deriveSecretKey("");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("openssl rand -base64 32");
    }
  });
});

describe("encryptSecret / decryptSecret", () => {
  const plain = "ghp_super_secret_token_value";

  it("往返一致，且带 v1 版本前缀", () => {
    const enc = encryptSecret(plain, KEY);
    expect(enc.startsWith("v1.")).toBe(true);
    expect(enc.split(".")).toHaveLength(4);
    expect(decryptSecret(enc, KEY)).toBe(plain);
  });

  it("每次加密 IV 不同（相同明文产出不同密文）", () => {
    expect(encryptSecret(plain, KEY)).not.toBe(encryptSecret(plain, KEY));
  });

  it("密文不含明文", () => {
    expect(encryptSecret(plain, KEY)).not.toContain(plain);
  });

  it("错误 key 解密失败", () => {
    const enc = encryptSecret(plain, KEY);
    const otherKey = deriveSecretKey("b".repeat(48));
    expect(() => decryptSecret(enc, otherKey)).toThrow();
  });

  it("密文被篡改时认证失败", () => {
    const [v, iv, tag, ct] = encryptSecret(plain, KEY).split(".");
    const flipped = Buffer.from(ct, "base64url");
    flipped[0] ^= 0xff;
    expect(() => decryptSecret([v, iv, tag, flipped.toString("base64url")].join("."), KEY)).toThrow();
  });

  it("AAD 不匹配时失败（防止把 A 行密文搬到 B 行）", () => {
    const enc = encryptSecret(plain, KEY, "gc-aaaaaaa1");
    expect(decryptSecret(enc, KEY, "gc-aaaaaaa1")).toBe(plain);
    expect(() => decryptSecret(enc, KEY, "gc-bbbbbbb2")).toThrow();
    expect(() => decryptSecret(enc, KEY)).toThrow();
  });

  it("未知版本前缀被拒（为将来轮换留的迁移点）", () => {
    const enc = encryptSecret(plain, KEY);
    expect(() => decryptSecret(`v2${enc.slice(2)}`, KEY)).toThrow(/unsupported encrypted secret format/);
  });

  it("格式非法时被拒", () => {
    for (const bad of ["", "v1.onlytwo", "garbage"]) {
      expect(() => decryptSecret(bad, KEY)).toThrow();
    }
  });
});

describe("fingerprintSecret", () => {
  const plain = "ghp_super_secret_token_value";

  it("稳定且为 16 位 hex", () => {
    const fp = fingerprintSecret(plain, KEY);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprintSecret(plain, KEY)).toBe(fp);
  });

  it("不同凭证指纹不同", () => {
    expect(fingerprintSecret("a".repeat(20), KEY)).not.toBe(fingerprintSecret("b".repeat(20), KEY));
  });

  it("依赖主密钥 —— 无主密钥无法离线枚举比对", () => {
    const other = deriveSecretKey("b".repeat(48));
    expect(fingerprintSecret(plain, other)).not.toBe(fingerprintSecret(plain, KEY));
  });

  it("不等于裸 sha256 前 16 位（裸哈希在 DB 泄漏后可被枚举）", () => {
    const bare = createHash("sha256").update(plain).digest("hex").slice(0, 16);
    expect(fingerprintSecret(plain, KEY)).not.toBe(bare);
  });
});
