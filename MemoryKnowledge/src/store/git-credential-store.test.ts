import { beforeEach, describe, expect, it } from "vitest";

import { createDb, type Db } from "../db/client.js";
import { SecretKeyError } from "../crypto/secret-box.js";
import { genGitCredentialId } from "./ids.js";
import { DuplicateCredentialNameError, createGitCredentialStore, type IGitCredentialStore } from "./git-credential-store.js";

/**
 * 这批用例守的是两条硬约束：
 *   1. 租户/团队收敛：同 service 的另一个 team 读不到凭证（KS 层面唯一的隔离手段）
 *   2. host 强绑定：凭证只对声明的主机生效（否则就是 token 外发原语）
 */

const SECRET_KEY = "k".repeat(48);
const SERVICE = "svc-A";
const TEAM = "team-1";
const TOKEN = "ghp_TESTTOKEN1234567890";

let db: Db;
let store: IGitCredentialStore;

beforeEach(() => {
  ({ db } = createDb({ path: ":memory:" }));
  store = createGitCredentialStore({ db, secretKey: SECRET_KEY });
});

function createToken(overrides: Partial<Parameters<IGitCredentialStore["create"]>[0]> = {}) {
  return store.create({
    credential_id: genGitCredentialId(),
    service_id: SERVICE,
    team_id: TEAM,
    name: "gitlab-pat",
    kind: "https_token",
    host: "git.example.com",
    username: "oauth2",
    secret: TOKEN,
    created_by: "user-1",
    ...overrides,
  });
}

describe("create / get / list", () => {
  it("创建后可读，且返回值不含密钥本体", () => {
    const row = createToken();
    expect(row.credential_id).toMatch(/^gc-[0-9a-z]{8}$/);
    expect(row.host).toBe("git.example.com");
    expect(row.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(row)).not.toContain(TOKEN);
  });

  it("host 落库前被归一化（大小写 / 尾点）", () => {
    const row = createToken({ host: "Git.Example.COM." });
    expect(row.host).toBe("git.example.com");
  });

  it("同一 team 内重名被拒（路由层转 409）", () => {
    createToken();
    expect(() => createToken()).toThrow(DuplicateCredentialNameError);
  });

  it("不同 team 可以重名", () => {
    createToken();
    expect(() => createToken({ team_id: "team-2" })).not.toThrow();
  });

  it("list 只返回本 team 的凭证", () => {
    createToken({ name: "a" });
    createToken({ name: "b", team_id: "team-2" });
    expect(store.list(SERVICE, TEAM).map((r) => r.name)).toEqual(["a"]);
    expect(store.list(SERVICE, "team-2").map((r) => r.name)).toEqual(["b"]);
  });

  it("未配置主密钥时 create 直接抛 SecretKeyError（不落库半条记录）", () => {
    const bare = createGitCredentialStore({ db, secretKey: "" });
    expect(() =>
      bare.create({
        credential_id: genGitCredentialId(),
        service_id: SERVICE,
        team_id: TEAM,
        name: "nokey",
        kind: "https_token",
        host: "git.example.com",
        secret: TOKEN,
      }),
    ).toThrow(SecretKeyError);
    expect(store.list(SERVICE, TEAM)).toHaveLength(0);
  });
});

describe("租户 / 团队收敛", () => {
  it("跨 team 读取返回 null", () => {
    const row = createToken();
    expect(store.get(SERVICE, TEAM, row.credential_id)).not.toBeNull();
    expect(store.get(SERVICE, "team-2", row.credential_id)).toBeNull();
  });

  it("跨 service 读取返回 null", () => {
    const row = createToken();
    expect(store.get("svc-B", TEAM, row.credential_id)).toBeNull();
  });

  it("跨 team 删除不会命中", () => {
    const row = createToken();
    const res = store.delete(SERVICE, "team-2", [row.credential_id]);
    expect(res.deleted_ids).toEqual([]);
    expect(res.failed).toEqual([{ id: row.credential_id, reason: "not found" }]);
    expect(store.get(SERVICE, TEAM, row.credential_id)).not.toBeNull();
  });
});

describe("delete（软删）", () => {
  it("删除后 list / get 都不再返回", () => {
    const row = createToken();
    const res = store.delete(SERVICE, TEAM, [row.credential_id]);
    expect(res.deleted_ids).toEqual([row.credential_id]);
    expect(store.get(SERVICE, TEAM, row.credential_id)).toBeNull();
    expect(store.list(SERVICE, TEAM)).toHaveLength(0);
  });

  it("删除后同名可以重新创建（partial unique index 只看未删行）", () => {
    const row = createToken();
    store.delete(SERVICE, TEAM, [row.credential_id]);
    expect(() => createToken()).not.toThrow();
  });

  it("不存在的 id 记入 failed", () => {
    const res = store.delete(SERVICE, TEAM, ["gc-00000000"]);
    expect(res.deleted_ids).toEqual([]);
    expect(res.failed[0]?.reason).toBe("not found");
  });
});

describe("resolveMaterial —— host 强绑定", () => {
  it("按 host 解析出可用于 git 的材料", () => {
    createToken();
    const auth = store.resolveMaterial(SERVICE, TEAM, "https://git.example.com/group/repo.git");
    expect(auth).toEqual({ kind: "https_token", username: "oauth2", token: TOKEN });
  });

  it("host 不匹配时返回 null（不能拿 A 主机的凭证去打 B 主机）", () => {
    createToken();
    expect(store.resolveMaterial(SERVICE, TEAM, "https://evil.example.com/group/repo.git")).toBeNull();
  });

  it("显式指定 credential_id 也必须与 repo_url 的 host 一致", () => {
    const row = createToken();
    expect(
      store.resolveMaterial(SERVICE, TEAM, "https://git.example.com/group/repo.git", row.credential_id),
    ).not.toBeNull();
    expect(
      store.resolveMaterial(SERVICE, TEAM, "https://evil.example.com/group/repo.git", row.credential_id),
    ).toBeNull();
  });

  it("跨 team 解析不到（防越权引用别人的凭证）", () => {
    createToken();
    expect(store.resolveMaterial(SERVICE, "team-2", "https://git.example.com/group/repo.git")).toBeNull();
  });

  it("已删除的凭证解析不到（build 会显式失败，而非静默降级为匿名）", () => {
    const row = createToken();
    store.delete(SERVICE, TEAM, [row.credential_id]);
    expect(
      store.resolveMaterial(SERVICE, TEAM, "https://git.example.com/group/repo.git", row.credential_id),
    ).toBeNull();
  });

  it("scp-like 的 host 同样参与匹配", () => {
    createToken();
    expect(store.resolveMaterial(SERVICE, TEAM, "git@git.example.com:group/repo.git")).not.toBeNull();
  });

  it("解析不了的 repo_url 返回 null", () => {
    createToken();
    expect(store.resolveMaterial(SERVICE, TEAM, "not a url")).toBeNull();
  });

  it("SSH 凭证解析为 privateKey 材料", () => {
    store.create({
      credential_id: genGitCredentialId(),
      service_id: SERVICE,
      team_id: TEAM,
      name: "deploy-key",
      kind: "ssh_key",
      host: "git.example.com",
      secret: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n",
    });
    const auth = store.resolveMaterial(SERVICE, TEAM, "git@git.example.com:group/repo.git");
    expect(auth?.kind).toBe("ssh_key");
    expect(auth?.privateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
  });
});

describe("findByHost / countForService / 审计", () => {
  it("findByHost 归一化后精确匹配", () => {
    createToken();
    expect(store.findByHost(SERVICE, TEAM, "GIT.EXAMPLE.COM.")?.name).toBe("gitlab-pat");
    expect(store.findByHost(SERVICE, TEAM, "other.example.com")).toBeNull();
  });

  it("countForService 反映未删数量", () => {
    expect(store.countForService(SERVICE)).toBe(0);
    const row = createToken();
    expect(store.countForService(SERVICE)).toBe(1);
    store.delete(SERVICE, TEAM, [row.credential_id]);
    expect(store.countForService(SERVICE)).toBe(0);
  });

  it("审计按 service 收敛且只记元数据", () => {
    const row = createToken();
    store.appendAudit({
      service_id: SERVICE,
      credential_id: row.credential_id,
      action: "create",
      user_id: "user-1",
      detail: `https_token for ${row.host}`,
    });
    const audit = store.listAudit(SERVICE, row.credential_id);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("create");
    expect(JSON.stringify(audit)).not.toContain(TOKEN);
    expect(store.listAudit("svc-B", row.credential_id)).toHaveLength(0);
  });
});
