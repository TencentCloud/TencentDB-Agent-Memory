/**
 * EnvelopeSecretStore 测试（949spec §5 / §6 / §30.1）。
 * - create → get 加解密 roundtrip；
 * - 密文不落明文（§5.1 不变量：数据库扫描不含 token）；
 * - AAD 绑定（篡改版本号后解密必须失败）；
 * - rotate 版本递增、revoke 后不可解析、delete 移除；
 * - master key 缺失 fail-closed。
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  EnvelopeSecretStore,
  generateMasterKey,
  fingerprintOf,
} from "../envelope-store.js";
import type { SecretStore } from "../secret-store.js";

const TEST_KEY = Buffer.from("0123456789abcdef0123456789abcdef"); // 32B
const TOKEN = "TKN_TEST_7b9d4e_f1a2b3c4";

function makeStore(masterKey: Buffer = TEST_KEY): { store: SecretStore; raw: Database.Database } {
  const raw = new Database(":memory:");
  raw.exec(`
    CREATE TABLE knowledge_credential (
      credential_ref TEXT NOT NULL, version INTEGER NOT NULL,
      service_id TEXT NOT NULL, team_id TEXT NOT NULL, code_graph_id TEXT NOT NULL,
      auth_method TEXT NOT NULL, username TEXT, provider TEXT, ciphertext TEXT NOT NULL,
      kek_version INTEGER NOT NULL DEFAULT 1, fingerprint TEXT, status TEXT NOT NULL DEFAULT 'active',
      last_validated_at TEXT, last_auth_failure_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (credential_ref, version)
    );
  `);
  const store = new EnvelopeSecretStore({ db: raw as unknown as Parameters<typeof EnvelopeSecretStore>[0]["db"], masterKey });
  return { store, raw };
}

const input = {
  serviceId: "svc_1",
  teamId: "team_1",
  codeGraphId: "cg_1",
  authMethod: "token" as const,
  secret: TOKEN,
  username: "octocat",
};

describe("EnvelopeSecretStore (§5/§6)", () => {
  let ctx: ReturnType<typeof makeStore>;
  beforeEach(() => {
    ctx = makeStore();
  });

  it("create → get roundtrip returns plaintext to caller", async () => {
    const ref = await ctx.store.createSecret(input);
    expect(ref.credentialRef).toMatch(/^cred_/);
    expect(ref.credentialVersion).toBe(1);
    const resolved = await ctx.store.getSecret(ref.credentialRef);
    expect(resolved?.secret).toBe(TOKEN);
    expect(resolved?.username).toBe("octocat");
  });

  it("§30.1 invariant: database contains no plaintext token", async () => {
    await ctx.store.createSecret(input);
    const rows = ctx.raw.prepare("SELECT ciphertext, username, provider, fingerprint FROM knowledge_credential").all();
    for (const r of rows) {
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    }
    // ciphertext is base64 and opaque — not equal to token
    expect(JSON.stringify(rows[0])).not.toContain(TOKEN);
  });

  it("rotate produces a new version; latest is resolvable", async () => {
    const ref = await ctx.store.createSecret(input);
    const rotated = await ctx.store.rotateSecret(ref.credentialRef, { secret: "TKN_NEW_9999" });
    expect(rotated.credentialVersion).toBe(2);
    const latest = await ctx.store.getSecret(ref.credentialRef);
    expect(latest?.secret).toBe("TKN_NEW_9999");
    expect(latest?.version).toBe(2);
  });

  it("revoke fails closed: getSecret returns null (§22)", async () => {
    const ref = await ctx.store.createSecret(input);
    await ctx.store.revokeSecret(ref.credentialRef);
    await expect(ctx.store.getSecret(ref.credentialRef)).resolves.toBeNull();
    const status = await ctx.store.getStatus(ref.credentialRef);
    expect(status?.status).toBe("revoked");
  });

  it("delete removes the credential entirely", async () => {
    const ref = await ctx.store.createSecret(input);
    await ctx.store.deleteSecret(ref.credentialRef);
    await expect(ctx.store.getStatus(ref.credentialRef)).resolves.toBeNull();
  });

  it("AAD binding: tampering with version breaks decryption", async () => {
    const ref = await ctx.store.createSecret(input);
    // 直接篡改库中 version（AAD 绑定版本号），解密必须失败（fail-closed）。
    ctx.raw.prepare("UPDATE knowledge_credential SET version=99 WHERE credential_ref=?").run(ref.credentialRef);
    await expect(ctx.store.getSecret(ref.credentialRef)).rejects.toThrow();
  });

  it("fingerprint is stable and does not leak the secret", async () => {
    const fp = fingerprintOf(TOKEN);
    expect(fp.startsWith("SHA256:")).toBe(true);
    expect(fp).not.toContain(TOKEN);
    expect(fingerprintOf(TOKEN)).toBe(fp);
  });

  it("recordAuthResult updates validated/failure timestamps", async () => {
    const ref = await ctx.store.createSecret(input);
    await ctx.store.recordAuthResult(ref.credentialRef, true);
    const status = await ctx.store.getStatus(ref.credentialRef);
    expect(status?.lastValidatedAt).toBeTruthy();
    await ctx.store.recordAuthResult(ref.credentialRef, false);
    const after = await ctx.store.getStatus(ref.credentialRef);
    expect(after?.lastAuthFailureAt).toBeTruthy();
  });

  it("getStatus returns metadata only (no secret)", async () => {
    const ref = await ctx.store.createSecret(input);
    const status = await ctx.store.getStatus(ref.credentialRef);
    expect(status).toMatchObject({
      credentialRef: ref.credentialRef,
      version: 1,
      status: "active",
      authMethod: "token",
    });
    expect(JSON.stringify(status)).not.toContain(TOKEN);
  });
});

describe("EnvelopeSecretStore key management (§6)", () => {
  it("generateMasterKey returns base64 32-byte key", () => {
    const key = generateMasterKey();
    expect(Buffer.from(key, "base64")).toHaveLength(32);
  });

  it("constructor fails closed without master key", () => {
    const raw = new Database(":memory:");
    expect(() => new EnvelopeSecretStore({ db: raw as never })).toThrow(/master key/);
  });
});
