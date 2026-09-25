/**
 * Source-Credential Routes — 托管 git 凭证（私有仓库接入）。
 *
 * 路径为 `/v3/source-credential/*`（前缀在 server.ts 挂载）。命名沿用
 * middleware/auth.ts 里既有的 `/source-credential/status` 只读白名单占位 ——
 * 凭证的概念是「某个 source 的凭证」（git 今天，local/ftp 以后），不是 git 专属。
 *
 * 端点：
 *   管理面（需 KNOWLEDGE_SERVICE_KEY）：create / list / get / delete / test
 *   只读面（白名单）：GET status
 *
 * 安全边界（改动前务必读完）：
 *   1. **绝不回显密钥本体**。响应只含指纹与元数据（见 toSourceCredentialDetail）。
 *   2. **`host` 必填，且与 repo_url 的 host 严格相等**。这是「token 外发原语」的
 *      唯一断点：/test 与 build 都允许调用方给任意 repo_url，若凭证能对任意 host
 *      生效，持 service key 者就能让服务端把团队 token 以 `Authorization: Basic`
 *      发到自己的主机 —— 等于把「托管密钥」变成「SSRF 回显窃取」。
 *   3. `service_id` 来自 `x-tdai-service-id`（自报），`team_id` 来自 body。KS 没有
 *      成员数据，因此「某人是否有权操作该 team 的凭证」必须由 Panel 侧
 *      `requireTeamMember` 门控 —— KS 不得直接暴露给终端用户。
 */

import { Hono } from "hono";
import type { Context } from "hono";

import {
  extractIdFields,
  isValidIdSegment,
  toSourceCredentialDetail,
  wrapError,
  wrapOk,
  type BatchDeleteResult,
} from "../api-helpers.js";
import { SecretKeyError } from "../crypto/secret-box.js";
import { assertUsablePrivateKey, DEFAULT_HTTPS_USERNAME } from "../source-fetcher/git-auth.js";
import { normalizeHost, parseGitUrl } from "../source-fetcher/git-url.js";
import {
  DuplicateCredentialNameError,
  genGitCredentialId,
  type GitCredentialKind,
  type IGitCredentialStore,
} from "../store/index.js";
import { stripUserInfo } from "../utils/sanitize.js";

export interface SourceCredentialRouteDeps {
  credentialStore: IGitCredentialStore;
  /** 凭证子系统是否可用（KNOWLEDGE_SECRET_KEY 已配置且可用）。 */
  configured: boolean;
  /** 复用 source-fetcher 的协议 / SSRF / host 白名单校验，避免两套规则漂移。 */
  validateRepoUrl: (repoUrl: string) => void;
  /** 用指定凭证探测远端仓库连通性；error 已脱敏。 */
  probeRemote: (input: {
    repoUrl: string;
    branch?: string;
    credentialId: string;
    serviceId: string;
    teamId: string;
  }) => Promise<{ ok: boolean; error?: string; note?: string }>;
}

const KINDS: readonly GitCredentialKind[] = ["https_token", "ssh_key"];

/** name 长度上限（同时是展示字段）。 */
const NAME_MAX = 120;
/** secret 长度上限：SSH 私钥一般 < 16KB，给足余量同时防滥用。 */
const SECRET_MAX = 64 * 1024;
/** 单次批量删除上限，对齐 code-graph/delete。 */
const DELETE_MAX = 100;

export function createSourceCredentialRoutes(deps: SourceCredentialRouteDeps): Hono {
  const app = new Hono();
  const { credentialStore } = deps;

  // ═══════════════════ 只读面 ═══════════════════

  /**
   * 凭证子系统状态。已在 auth 白名单中（原设计就是这样），因此只回
   * 「是否配置 + 数量」这类**非租户数据**，不暴露任何凭证内容。
   */
  app.get("/status", (c) => {
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) {
      return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    }
    return c.json(
      wrapOk({
        configured: deps.configured,
        count: deps.configured ? credentialStore.countForService(serviceId) : 0,
        kinds: [...KINDS],
      }),
    );
  });

  /** 支持的凭证类型与配置要求（静态信息，不含任何实例数据）。 */
  app.get("/providers", (c) => {
    return c.json(
      wrapOk({
        providers: [
          {
            kind: "https_token",
            label: "HTTPS token",
            default_username: DEFAULT_HTTPS_USERNAME,
            fields: ["name", "host", "username", "secret"],
            note: "GitHub/GitLab/Gitea PAT. GitHub App installation tokens must set username=x-access-token.",
          },
          {
            kind: "ssh_key",
            label: "SSH private key",
            fields: ["name", "host", "secret"],
            note: "Unencrypted OpenSSH/PEM key. Passphrase-protected keys are rejected. Host keys are trusted on first use unless KNOWLEDGE_GIT_STRICT_HOST_KEY=on.",
          },
        ],
      }),
    );
  });

  // ═══════════════════ 管理面（需 service key） ═══════════════════

  app.post("/create", async (c) => {
    const body = await readBody(c);
    const idFields = extractIdFields(c.req.header("x-tdai-service-id"), body);
    if (!idFields) {
      return c.json(wrapError(400, "x-tdai-service-id header and team_id are required"), 400);
    }

    if (!deps.configured) return c.json(wrapError(503, secretKeyHint()), 503);

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > NAME_MAX) {
      return c.json(wrapError(400, `name is required and must be at most ${NAME_MAX} chars`), 400);
    }

    const kind = body.kind;
    if (typeof kind !== "string" || !KINDS.includes(kind as GitCredentialKind)) {
      return c.json(wrapError(400, `kind must be one of ${KINDS.join(", ")}`), 400);
    }

    const host = normalizeHost(typeof body.host === "string" ? body.host : "");
    if (!host) {
      return c.json(
        wrapError(400, "host is required: a credential is only usable for the host it declares"),
        400,
      );
    }

    const secret = typeof body.secret === "string" ? body.secret : "";
    if (!secret.trim()) return c.json(wrapError(400, "secret is required"), 400);
    if (secret.length > SECRET_MAX) return c.json(wrapError(400, "secret is too large"), 400);

    const username =
      typeof body.username === "string" && body.username.trim()
        ? body.username.trim()
        : kind === "https_token"
          ? DEFAULT_HTTPS_USERNAME
          : null;

    // SSH 私钥必须在入库前确认「可用且未加密」：不能靠扫 PEM 文本判断
    // （OpenSSH 新格式把加密标志编码在 base64 里），否则加密私钥会被放行、
    // 然后在 build 阶段静默失败。
    if (kind === "ssh_key") {
      try {
        assertUsablePrivateKey(secret);
      } catch (err) {
        return c.json(wrapError(422, stripUserInfo(errorMessage(err))), 422);
      }
    }

    const credentialId = genGitCredentialId();
    try {
      const row = credentialStore.create({
        credential_id: credentialId,
        service_id: idFields.service_id,
        team_id: idFields.team_id,
        name,
        kind: kind as GitCredentialKind,
        host,
        username,
        secret,
        created_by: idFields.user_id ?? null,
      });

      // 审计只记 host，绝不记密钥。
      credentialStore.appendAudit({
        service_id: idFields.service_id,
        credential_id: credentialId,
        action: "create",
        user_id: idFields.user_id ?? null,
        detail: `${row.kind} for ${row.host}`,
      });

      return c.json(wrapOk(toSourceCredentialDetail(row)), 201);
    } catch (err) {
      if (err instanceof DuplicateCredentialNameError) {
        return c.json(wrapError(409, err.message), 409);
      }
      if (err instanceof SecretKeyError) {
        return c.json(wrapError(503, secretKeyHint()), 503);
      }
      throw err;
    }
  });

  app.post("/list", async (c) => {
    const body = await readBody(c);
    const idFields = extractIdFields(c.req.header("x-tdai-service-id"), body);
    if (!idFields) {
      return c.json(wrapError(400, "x-tdai-service-id header and team_id are required"), 400);
    }

    const items = credentialStore
      .list(idFields.service_id, idFields.team_id)
      .map(toSourceCredentialDetail);
    return c.json(wrapOk({ items, total: items.length }));
  });

  app.post("/get", async (c) => {
    const body = await readBody(c);
    const idFields = extractIdFields(c.req.header("x-tdai-service-id"), body);
    if (!idFields) {
      return c.json(wrapError(400, "x-tdai-service-id header and team_id are required"), 400);
    }

    const credentialId = body.credential_id;
    if (!isValidIdSegment(credentialId)) {
      return c.json(wrapError(400, "credential_id is required"), 400);
    }

    // 带 team 收敛：同一个 service 的另一个 team 读不到。
    const row = credentialStore.get(idFields.service_id, idFields.team_id, credentialId);
    if (!row) return c.json(wrapError(404, "source credential not found"), 404);

    return c.json(wrapOk(toSourceCredentialDetail(row)));
  });

  app.post("/delete", async (c) => {
    const body = await readBody(c);
    const idFields = extractIdFields(c.req.header("x-tdai-service-id"), body);
    if (!idFields) {
      return c.json(wrapError(400, "x-tdai-service-id header and team_id are required"), 400);
    }

    const ids = body.credential_ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      return c.json(wrapError(400, "credential_ids is required (non-empty array)"), 400);
    }
    if (ids.length > DELETE_MAX) {
      return c.json(wrapError(400, `credential_ids exceeds max ${DELETE_MAX}`), 400);
    }

    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    const valid: string[] = [];
    for (const id of ids) {
      if (!isValidIdSegment(id)) {
        result.failed.push({ id: String(id), reason: "invalid id" });
        continue;
      }
      valid.push(id);
    }

    const deleted = credentialStore.delete(idFields.service_id, idFields.team_id, valid);
    result.deleted_ids.push(...deleted.deleted_ids);
    result.failed.push(...deleted.failed);

    for (const id of deleted.deleted_ids) {
      credentialStore.appendAudit({
        service_id: idFields.service_id,
        credential_id: id,
        action: "delete",
        user_id: idFields.user_id ?? null,
        detail: null,
      });
    }

    return c.json(wrapOk(result));
  });

  /**
   * 连通性探测：用该凭证对目标仓库跑一次 `git ls-remote`。
   *
   * 三重门：
   *   1. credential 必须属于本 service + 本 team（否则 404，防跨租户越权探测）
   *   2. host 必须与 credential.host 严格相等（否则 404，防 token 外发到任意主机）
   *   3. repo_url 还要过 source-fetcher 的协议 / SSRF / host 白名单校验
   */
  app.post("/test", async (c) => {
    const body = await readBody(c);
    const idFields = extractIdFields(c.req.header("x-tdai-service-id"), body);
    if (!idFields) {
      return c.json(wrapError(400, "x-tdai-service-id header and team_id are required"), 400);
    }

    const credentialId = body.credential_id;
    if (!isValidIdSegment(credentialId)) {
      return c.json(wrapError(400, "credential_id is required"), 400);
    }
    const repoUrl = typeof body.repo_url === "string" ? body.repo_url.trim() : "";
    if (!repoUrl) return c.json(wrapError(400, "repo_url is required"), 400);
    const branch = typeof body.branch === "string" && body.branch ? body.branch : undefined;

    const row = credentialStore.get(idFields.service_id, idFields.team_id, credentialId);
    if (!row) return c.json(wrapError(404, "source credential not found"), 404);

    const parsed = parseGitUrl(repoUrl);
    if (!parsed) return c.json(wrapError(400, "invalid repo_url"), 400);

    // host 强绑定：本次实现里最容易被忽略、后果最重的一条校验。
    if (parsed.host !== row.host) {
      return c.json(
        wrapError(
          404,
          `credential ${credentialId} is bound to ${row.host} and cannot be used for ${parsed.host}`,
        ),
        404,
      );
    }

    try {
      deps.validateRepoUrl(repoUrl);
    } catch (err) {
      return c.json(wrapError(400, stripUserInfo(errorMessage(err))), 400);
    }

    let result: { ok: boolean; error?: string; note?: string };
    try {
      result = await deps.probeRemote({
        repoUrl,
        branch,
        credentialId,
        serviceId: idFields.service_id,
        teamId: idFields.team_id,
      });
    } catch (err) {
      result = { ok: false, error: stripUserInfo(errorMessage(err)) };
    }

    credentialStore.appendAudit({
      service_id: idFields.service_id,
      credential_id: credentialId,
      action: "test",
      user_id: idFields.user_id ?? null,
      detail: `${repoUrl} → ${result.ok ? "ok" : "failed"}`,
    });

    return c.json(wrapOk(result));
  });

  return app;
}

function secretKeyHint(): string {
  return (
    "KNOWLEDGE_SECRET_KEY is not configured; managed git credentials are unavailable. " +
    "Generate one with: openssl rand -base64 32"
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const parsed = await c.req.json<Record<string, unknown>>();
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
