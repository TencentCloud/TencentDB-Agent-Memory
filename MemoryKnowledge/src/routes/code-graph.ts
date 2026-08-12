/**
 * Code-Graph Routes — 13 endpoints (Hono rewrite).
 *
 * Management (5): create / list / get / sync / delete
 * Query (8): search / explore / callers / callees / impact / node / status / files
 *
 * Query endpoints delegate to engines/code executeTool, return {text, isError}.
 * Routes are defined WITHOUT /v2 prefix — prefix applied at server.ts mount level.
 *
 * 多租户（001）：`service_id` 每个端点必传于 `x-tdai-service-id` 请求头（与内核路由键统一）。
 * id-only 端点用 `getById(service_id, code_graph_id)` 收敛归属，跨租户返回 404（R1）；
 * service_id / code_graph_id 先做路径分段白名单校验（R5）。
 */

import { Hono } from "hono";

import type { CodeGraphService } from "../store/index.js";
import type { SyncStatus } from "../store/index.js";
import { executeTool as executeCodeTool } from "../engines/code/index.js";
import { toCodeGraphToolName, CODEGRAPH_QUERY_TOOL_NAMES } from "./tools.js";
import {
  extractIdFields,
  isValidIdSegment,
  wrapOk,
  wrapError,
  toCodeGraphDetail,
  type BatchDeleteResult,
} from "../api-helpers.js";
import type { CodeGraphInstancePool } from "../module.js";
import type { SecretStore } from "../secrets/secret-store.js";
import { canonicalizeGitUrl, GitUrlError, GIT_URL_ERROR } from "../source-fetcher/url-security.js";
import { GitSourceFetcher, GitFetchError, FETCH_ERROR } from "../source-fetcher/git-fetcher.js";
import type { FetchOptions } from "../source-fetcher/types.js";

export interface CodeGraphRouteDeps {
  cgService: CodeGraphService;
  instancePool: CodeGraphInstancePool;
  /** Public base URL for service_url; should already include the API prefix (e.g. http://host:8421/v3). */
  publicBaseUrl: string;
  /** 凭据存储（949spec §5.3）；未配置时 create 的凭据走 legacy 明文列（迁移期）。 */
  secretStore?: SecretStore;
  /** Git 连接测试器（§23）；缺省懒创建。 */
  gitFetcher?: GitSourceFetcher;
}

const AUTH_METHODS = ["none", "token", "ssh"] as const;
type AuthMethod = (typeof AUTH_METHODS)[number];

/** 稳定错误码映射（949spec §25）：source-fetcher / url-security 层错误码 → 客户端响应。 */
function gitErrorToHttp(err: unknown): { status: 400 | 401 | 404 | 500 | 504; code: string } {
  if (err instanceof GitUrlError) {
    switch (err.code) {
      case GIT_URL_ERROR.CREDENTIAL_IN_URL_NOT_ALLOWED:
        return { status: 400, code: "CREDENTIAL_IN_URL_NOT_ALLOWED" };
      case GIT_URL_ERROR.UNSUPPORTED_PROTOCOL:
        return { status: 400, code: "UNSUPPORTED_PROTOCOL" };
      case GIT_URL_ERROR.MALFORMED_URL:
        return { status: 400, code: "MALFORMED_URL" };
      case GIT_URL_ERROR.PRIVATE_ADDRESS_BLOCKED:
        return { status: 400, code: "GIT_NETWORK_POLICY_BLOCKED" };
      case GIT_URL_ERROR.DNS_RESOLUTION_BLOCKED:
        return { status: 400, code: "GIT_DNS_RESOLUTION_BLOCKED" };
      case GIT_URL_ERROR.DNS_RESOLUTION_FAILED:
        return { status: 400, code: "GIT_DNS_RESOLUTION_BLOCKED" };
      default:
        return { status: 400, code: err.code };
    }
  }
  if (err instanceof GitFetchError) {
    const map: Record<string, { status: 400 | 401 | 404 | 500 | 504; code: string }> = {
      [FETCH_ERROR.GIT_SSH_HOST_UNTRUSTED]: { status: 400, code: "GIT_SSH_HOST_UNTRUSTED" },
      [FETCH_ERROR.GIT_SSH_HOST_KEY_MISMATCH]: { status: 400, code: "GIT_SSH_HOST_KEY_MISMATCH" },
      [FETCH_ERROR.GIT_AUTH_FAILED]: { status: 401, code: "GIT_AUTH_FAILED" },
      [FETCH_ERROR.GIT_REPO_NOT_FOUND]: { status: 404, code: "GIT_REPO_NOT_FOUND" },
      [FETCH_ERROR.GIT_CLONE_TIMEOUT]: { status: 504, code: "GIT_CLONE_TIMEOUT" },
      [FETCH_ERROR.GIT_FETCH_TIMEOUT]: { status: 504, code: "GIT_CLONE_TIMEOUT" },
    };
    return map[err.code] ?? { status: 400, code: "GIT_FETCH_FAILED" };
  }
  return { status: 400, code: "GIT_FETCH_FAILED" };
}

// ───────────────────────── Query Specs ─────────────────────────

type FieldRule =
  | { kind: "string"; required?: boolean }
  | { kind: "stringEnum"; required?: boolean; values: string[]; passthrough?: boolean; default?: string }
  | { kind: "boolean"; required?: boolean; default?: boolean }
  | { kind: "int"; required?: boolean; min?: number; max?: number; default?: number };

interface QuerySpec {
  fields: Record<string, FieldRule>;
}

const QUERY_SPECS: Record<string, QuerySpec> = {
  search: {
    fields: {
      query: { kind: "string", required: true },
      kind: {
        kind: "stringEnum",
        values: ["function", "method", "class", "interface", "type", "variable", "route", "component"],
        passthrough: true,
      },
      limit: { kind: "int", min: 1, max: 100, default: 10 },
    },
  },
  explore: {
    fields: {
      query: { kind: "string", required: true },
      maxFiles: { kind: "int", min: 1, max: 200, default: 12 },
    },
  },
  callers: {
    fields: {
      symbol: { kind: "string", required: true },
      limit: { kind: "int", min: 1, max: 200, default: 20 },
    },
  },
  callees: {
    fields: {
      symbol: { kind: "string", required: true },
      limit: { kind: "int", min: 1, max: 200, default: 20 },
    },
  },
  impact: {
    fields: {
      symbol: { kind: "string", required: true },
      depth: { kind: "int", min: 1, max: 10, default: 2 },
    },
  },
  node: {
    fields: {
      symbol: { kind: "string", required: true },
      includeCode: { kind: "boolean", default: false },
      file: { kind: "string" },
      line: { kind: "int", min: 1 },
    },
  },
  status: {
    fields: {},
  },
  files: {
    fields: {
      path: { kind: "string" },
      pattern: { kind: "string" },
      format: { kind: "stringEnum", values: ["tree", "flat", "grouped"], default: "tree", passthrough: true } as FieldRule,
      includeMetadata: { kind: "boolean", default: true },
      maxDepth: { kind: "int", min: 1 },
    },
  },
};

/** Validate query params against spec whitelist + defaults. Returns toolParams or error string. */
function buildToolParams(
  action: string,
  body: Record<string, unknown>,
): { params: Record<string, unknown> } | { error: string } {
  const spec = QUERY_SPECS[action];
  if (!spec) return { error: `unknown action: ${action}` };

  // code_graph_id is the resource routing key consumed by the route handler
  // (not a tool param); allow it so it doesn't trip the undeclared-field guard,
  // but it is never copied into toolParams. service_id now arrives via the
  // x-tdai-service-id header, so it never appears in the body.
  const allowed = new Set(["code_graph_id", ...Object.keys(spec.fields)]);

  // Reject undeclared fields
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) {
      return { error: `unexpected field: ${k}` };
    }
  }

  const params: Record<string, unknown> = {};
  for (const [name, rule] of Object.entries(spec.fields)) {
    const raw = body[name];
    const present = raw !== undefined && raw !== null;

    if (!present) {
      if (rule.required) return { error: `${name} is required` };
      if ("default" in rule && rule.default !== undefined) {
        const passthrough = rule.kind !== "stringEnum" || rule.passthrough !== false;
        if (passthrough) params[name] = rule.default;
      }
      continue;
    }

    switch (rule.kind) {
      case "string": {
        if (typeof raw !== "string" || !raw) return { error: `${name} must be non-empty string` };
        params[name] = raw;
        break;
      }
      case "stringEnum": {
        if (typeof raw !== "string" || !rule.values.includes(raw)) {
          return { error: `${name} must be one of ${rule.values.join(", ")}` };
        }
        if (rule.passthrough !== false) params[name] = raw;
        break;
      }
      case "boolean": {
        if (typeof raw !== "boolean") return { error: `${name} must be boolean` };
        params[name] = raw;
        break;
      }
      case "int": {
        if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
          return { error: `${name} must be integer` };
        }
        if (rule.min !== undefined && raw < rule.min) return { error: `${name} must be >= ${rule.min}` };
        if (rule.max !== undefined && raw > rule.max) return { error: `${name} must be <= ${rule.max}` };
        params[name] = raw;
        break;
      }
    }
  }

  return { params };
}

export function createCodeGraphRoutes(deps: CodeGraphRouteDeps): Hono {
  const app = new Hono();
  const { cgService, instancePool, publicBaseUrl } = deps;
  const secretStore = deps.secretStore;
  const gitFetcher = deps.gitFetcher ?? new GitSourceFetcher();

  /** 由行 + SecretStore 解析出连接测试用的 FetchOptions（明文只存在于调用栈）。 */
  async function resolveFetchOptionsForTest(
    serviceId: string,
    cgId: string,
  ): Promise<FetchOptions> {
    const row = cgService.getById(serviceId, cgId);
    if (!row) throw new Error("not found");
    const method = row.auth_method as "none" | "token" | "ssh";
    if (method === "none") return { authMethod: "none" };
    if (!secretStore) throw new Error("SecretStore not configured");
    if (!row.credential_ref) throw new Error("no credential bound");
    const resolved = await secretStore.getSecret(row.credential_ref);
    if (!resolved) throw new Error("credential not found or revoked");
    return {
      authMethod: resolved.authMethod === "ssh" ? "ssh" : "token",
      accessToken: resolved.authMethod === "token" ? resolved.secret : undefined,
      tokenUsername: resolved.username,
      sshPrivateKey: resolved.authMethod === "ssh" ? resolved.secret : undefined,
      provider: (row.credential_provider ?? undefined) as FetchOptions["provider"],
    };
  }

  // ═══════════════════ Management ═══════════════════

  app.post("/create", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const idFields = extractIdFields(c.req.header("x-tdai-service-id"), body);
    if (!idFields) return c.json(wrapError(400, "x-tdai-service-id header and team_id are required"), 400);

    const repoUrl = body.repo_url;
    if (typeof repoUrl !== "string" || !repoUrl) return c.json(wrapError(400, "repo_url is required"), 400);

    // §9/§18：URL 规范化 —— 拒绝 userinfo（CREDENTIAL_IN_URL_NOT_ALLOWED）、
    // 控制字符/换行注入、http 明文、非法协议。repo_url 恒为干净 URL。
    let cleanRepoUrl: string;
    try {
      cleanRepoUrl = canonicalizeGitUrl(repoUrl).url;
    } catch (err) {
      const { status, code } = gitErrorToHttp(err);
      return c.json(wrapError(status, code), status);
    }

    const branch = typeof body.branch === "string" && body.branch ? body.branch : "main";
    const repoName = typeof body.repo_name === "string" ? body.repo_name : undefined;

    // ── 私有仓库认证（auth_method: none | token | ssh）──
    const authMethodRaw = body.auth_method;
    let authMethod: AuthMethod =
      authMethodRaw === undefined || authMethodRaw === null
        ? "none"
        : (String(authMethodRaw) as AuthMethod);
    if (!AUTH_METHODS.includes(authMethod as AuthMethod)) {
      return c.json(wrapError(400, `auth_method must be one of ${AUTH_METHODS.join("/")}`), 400);
    }
    const accessToken = typeof body.access_token === "string" && body.access_token ? body.access_token : undefined;
    const tokenUsername =
      typeof body.token_username === "string" && body.token_username ? body.token_username : undefined;
    const sshPrivateKey =
      typeof body.ssh_private_key === "string" && body.ssh_private_key ? body.ssh_private_key : undefined;
    const credentialRefRaw = typeof body.credential_ref === "string" && body.credential_ref ? body.credential_ref : undefined;

    // §17 无效组合：auth=none 不得携带凭据材料。
    if (authMethod === "none" && (accessToken || sshPrivateKey || credentialRefRaw)) {
      return c.json(wrapError(400, "auth=none must not carry credential material"), 400);
    }

    // credential_ref 复用：校验存在性 + authMethod 匹配（§17 无效组合必须拒绝）。
    let credentialVersion: number | null = null;
    let credentialFingerprint: string | null = null;
    const credentialProvider =
      (typeof body.credential_provider === "string" ? body.credential_provider : null) ?? null;
    if (credentialRefRaw) {
      if (!deps.secretStore) {
        return c.json(wrapError(400, "credential_ref provided but SecretStore is not configured"), 400);
      }
      const status = await deps.secretStore.getStatus(credentialRefRaw);
      if (!status) {
        return c.json(wrapError(404, "CREDENTIAL_REF_NOT_FOUND"), 404);
      }
      if (status.status === "revoked") {
        return c.json(wrapError(400, "CREDENTIAL_REVOKED"), 400);
      }
      if (status.authMethod !== (authMethod === "token" ? "token" : "ssh")) {
        return c.json(wrapError(400, "credential auth method mismatch"), 400);
      }
      credentialVersion = status.version;
      credentialFingerprint = status.fingerprint ?? null;
    }
    if (!credentialRefRaw && (authMethod === "token" || authMethod === "ssh")) {
      const missing = authMethod === "token" ? "access_token" : "ssh_private_key";
      const provided = authMethod === "token" ? accessToken : sshPrivateKey;
      if (!provided) {
        return c.json(wrapError(400, `${missing} is required for auth_method=${authMethod} (or reuse credential_ref)`), 400);
      }
    }

    const { row, existed } = await cgService.create({
      service_id: idFields.service_id,
      team_id: idFields.team_id,
      repo_url: cleanRepoUrl,
      branch,
      repo_name: repoName,
      auth_method: authMethod,
      access_token: accessToken ?? null,
      token_username: tokenUsername ?? null,
      ssh_private_key: sshPrivateKey ?? null,
      credential_ref: credentialRefRaw ?? null,
      credential_version: credentialVersion,
      credential_fingerprint: credentialFingerprint,
      credential_provider: credentialProvider,
      owner_user_id: idFields.user_id,
      user_id: idFields.user_id,
      agent_id: idFields.agent_id,
      task_id: idFields.task_id,
    });

    // Persist service_url (tools self-discovery base; resource selected via
    // knowledge_id in request body, so the URL is service-level, not
    // resource-scoped). publicBaseUrl already includes the API prefix; proxy
    // appends `/tools/list` | `/tools/call` directly.
    if (!existed && publicBaseUrl) {
      const serviceUrl = publicBaseUrl;
      const updated = cgService.updateServiceUrl(idFields.service_id, row.code_graph_id, serviceUrl);
      if (updated) return c.json(wrapOk(toCodeGraphDetail(updated)), 201);
    }

    return c.json(wrapOk(toCodeGraphDetail(row)), existed ? 200 : 201);
  });

  app.post("/list", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const idFields = extractIdFields(c.req.header("x-tdai-service-id"), body);
    if (!idFields) return c.json(wrapError(400, "x-tdai-service-id header and team_id are required"), 400);

    const status = typeof body.status === "string" ? (body.status as SyncStatus) : undefined;
    const limit = typeof body.limit === "number" ? body.limit : 20;
    const offset = typeof body.offset === "number" ? body.offset : 0;

    const items = cgService.list(idFields.service_id, idFields.team_id, { syncStatus: status, limit, offset });
    const total = cgService.count(idFields.service_id, idFields.team_id, status ? { syncStatus: status } : undefined);
    return c.json(wrapOk({ items: items.map(toCodeGraphDetail), total }));
  });

  app.post("/get", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const cgId = body.code_graph_id;
    if (!isValidIdSegment(cgId)) return c.json(wrapError(400, "code_graph_id is required"), 400);

    const row = cgService.getById(serviceId, cgId);
    if (!row) return c.json(wrapError(404, "code graph not found"), 404);
    return c.json(wrapOk(toCodeGraphDetail(row)));
  });

  app.post("/update-meta", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const cgId = body.code_graph_id;
    if (!isValidIdSegment(cgId)) return c.json(wrapError(400, "code_graph_id is required"), 400);

    const patch: { repo_name?: string; summary?: string | null } = {};
    if (typeof body.repo_name === "string" && body.repo_name) patch.repo_name = body.repo_name;
    if (body.summary !== undefined) {
      patch.summary = typeof body.summary === "string" ? body.summary : null;
    }
    if (!patch.repo_name && patch.summary === undefined) {
      return c.json(wrapError(400, "at least one of repo_name/summary must be provided"), 400);
    }

    const updated = cgService.updateMeta(serviceId, cgId, patch);
    if (!updated) return c.json(wrapError(404, "code graph not found"), 404);
    return c.json(wrapOk(toCodeGraphDetail(updated)));
  });

  app.post("/sync", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const cgId = body.code_graph_id;
    if (!isValidIdSegment(cgId)) return c.json(wrapError(400, "code_graph_id is required"), 400);
    const requesterUserId = typeof body.user_id === "string" && body.user_id ? body.user_id : undefined;

    const row = cgService.getById(serviceId, cgId);
    if (!row) return c.json(wrapError(404, "code graph not found"), 404);

    const result = cgService.sync(serviceId, row.team_id, cgId, requesterUserId);
    if (result.kind === "not_found") return c.json(wrapError(404, "code graph not found"), 404);
    if (result.kind === "busy") {
      // 并发拒绝：干净最小的 409 响应体（调用方用 code 判断，不 parse message）。
      return c.json({ code: 409, message: "busy", data: { status: result.status, step: result.step } }, 409);
    }
    return c.json(wrapOk({ code_graph_id: result.row.code_graph_id, status: result.row.status }), 202);
  });

  app.post("/delete", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const cgIds = body.code_graph_ids;
    if (!Array.isArray(cgIds) || cgIds.length === 0) {
      return c.json(wrapError(400, "code_graph_ids is required (non-empty array)"), 400);
    }
    if (cgIds.length > 100) {
      return c.json(wrapError(400, "code_graph_ids exceeds max 100"), 400);
    }

    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of cgIds) {
      if (!isValidIdSegment(id)) {
        result.failed.push({ id: String(id), reason: "invalid id" });
        continue;
      }
      const row = cgService.getById(serviceId, id);
      if (!row) {
        result.failed.push({ id, reason: "not found" });
        continue;
      }
      const ok = cgService.delete(serviceId, row.team_id, id);
      if (ok) {
        // instance pool 释放已由 service.cleanupResources(releaseInstance) 统一处理。
        result.deleted_ids.push(id);
      } else {
        result.failed.push({ id, reason: "delete failed" });
      }
    }
    return c.json(wrapOk(result));
  });

  // ═══════════════════ Credential lifecycle (§19/§20/§22/§23) ═══════════════════

  // PUT /credential — 设置/轮换凭据（§19 PUT /code-graphs/:id/credential；§20 rotation）。
  // 不重建 code-graph 资产；新明文立即加密转入 SecretStore 产生新版本。
  app.post("/credential/rotate", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const cgId = body.code_graph_id;
    if (!isValidIdSegment(cgId)) return c.json(wrapError(400, "code_graph_id is required"), 400);

    const row = cgService.getById(serviceId, cgId);
    if (!row) return c.json(wrapError(404, "code graph not found"), 404);
    if (row.auth_method === "none") {
      return c.json(wrapError(400, "code graph has no credential to rotate"), 400);
    }
    if (!secretStore) {
      return c.json(wrapError(400, "SecretStore is not configured"), 400);
    }
    if (!row.credential_ref) {
      return c.json(wrapError(400, "no credential_ref bound; migrate the row first"), 400);
    }

    const secret = typeof body.credential_secret === "string" && body.credential_secret
      ? body.credential_secret
      : undefined;
    if (!secret) {
      return c.json(wrapError(400, "credential_secret (new token or private key) is required"), 400);
    }
    const username = typeof body.token_username === "string" ? body.token_username : undefined;

    try {
      const ref = await secretStore.rotateSecret(row.credential_ref, { secret, username });
      cgService.updateCredentialBinding(serviceId, cgId, {
        credential_version: ref.credentialVersion,
        credential_fingerprint: ref.fingerprint ?? null,
        credential_status: "active",
      });
      return c.json(wrapOk({ code_graph_id: cgId, credential_ref: ref.credentialRef, credential_version: ref.credentialVersion }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(wrapError(500, `credential rotation failed: ${msg.slice(0, 200)}`), 500);
    }
  });

  // POST /credential/test — 连接测试（§23）：与真实 fetch 相同的安全路径执行 ls-remote。
  app.post("/credential/test", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const cgId = body.code_graph_id;
    if (!isValidIdSegment(cgId)) return c.json(wrapError(400, "code_graph_id is required"), 400);

    const row = cgService.getById(serviceId, cgId);
    if (!row) return c.json(wrapError(404, "code graph not found"), 404);

    let opts: FetchOptions;
    try {
      opts = await resolveFetchOptionsForTest(serviceId, cgId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(wrapError(400, msg.includes("revoked") ? "CREDENTIAL_REVOKED" : msg.slice(0, 200)), 400);
    }

    try {
      await gitFetcher.testConnection(row.repo_url, opts);
      await secretStore?.recordAuthResult(row.credential_ref ?? "", true);
      cgService.updateCredentialBinding(serviceId, cgId, {
        credential_last_validated_at: new Date().toISOString(),
        credential_status: "active",
      });
      return c.json(wrapOk({ status: "SUCCESS", code_graph_id: cgId }));
    } catch (err) {
      await secretStore?.recordAuthResult(row.credential_ref ?? "", false);
      cgService.updateCredentialBinding(serviceId, cgId, {
        credential_last_auth_failure_at: new Date().toISOString(),
        credential_status: "invalid",
      });
      const { status, code } = gitErrorToHttp(err);
      return c.json(wrapError(status, code), status);
    }
  });

  // DELETE /credential — 吊销绑定（§19 DELETE /code-graphs/:id/credential；§22 revocation）。
  app.post("/credential/revoke", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const cgId = body.code_graph_id;
    if (!isValidIdSegment(cgId)) return c.json(wrapError(400, "code_graph_id is required"), 400);

    const row = cgService.getById(serviceId, cgId);
    if (!row) return c.json(wrapError(404, "code graph not found"), 404);
    if (!secretStore || !row.credential_ref) {
      return c.json(wrapError(400, "no credential_ref bound"), 400);
    }
    await secretStore.revokeSecret(row.credential_ref);
    cgService.updateCredentialBinding(serviceId, cgId, { credential_status: "revoked" });
    return c.json(wrapOk({ code_graph_id: cgId, status: "revoked" }));
  });

  // GET /credential/status — 凭据元数据（§19 可选端点；无明文）。
  app.post("/credential/status", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const cgId = body.code_graph_id;
    if (!isValidIdSegment(cgId)) return c.json(wrapError(400, "code_graph_id is required"), 400);

    const row = cgService.getById(serviceId, cgId);
    if (!row) return c.json(wrapError(404, "code graph not found"), 404);
    if (!secretStore || !row.credential_ref) {
      return c.json(wrapOk({ code_graph_id: cgId, bound: false }));
    }
    const status = await secretStore.getStatus(row.credential_ref);
    if (!status) return c.json(wrapOk({ code_graph_id: cgId, bound: true, credential_ref: row.credential_ref, status: "missing" }));
    return c.json(
      wrapOk({
        code_graph_id: cgId,
        bound: true,
        credential_ref: status.credentialRef,
        credential_version: status.version,
        status: status.status,
        auth_method: status.authMethod,
        fingerprint: status.fingerprint,
        provider: status.provider,
        last_validated_at: status.lastValidatedAt,
        last_auth_failure_at: status.lastAuthFailureAt,
      }),
    );
  });

  // ═══════════════════ Query (8 codegraph tools, all id-only) ═══════════════════

  // Register all query endpoints from the shared tool name list
  for (const action of CODEGRAPH_QUERY_TOOL_NAMES) {
    app.post(`/${action}`, async (c) => {
      const body = await c.req.json<Record<string, unknown>>();

      const serviceId = c.req.header("x-tdai-service-id");
      if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
      const cgId = body.code_graph_id;
      if (!isValidIdSegment(cgId)) return c.json(wrapError(400, "code_graph_id is required"), 400);

      const row = cgService.getById(serviceId, cgId);
      if (!row) return c.json(wrapError(404, "code graph not found"), 404);

      if (row.status !== "ready") {
        return c.json(wrapOk({ text: "", isError: false }));
      }

      let instance = instancePool.get(cgId);
      if (!instance && instancePool.loadIfMissing) {
        const dir = cgService.dirFor(serviceId, row.team_id, cgId);
        instance = await instancePool.loadIfMissing(cgId, dir);
      }
      if (!instance) {
        return c.json(wrapError(503, "code graph instance not loaded"), 503);
      }

      const built = buildToolParams(action, body);
      if ("error" in built) {
        return c.json(wrapError(400, built.error), 400);
      }

      const toolName = toCodeGraphToolName(action);
      if (!toolName) {
        return c.json(wrapError(403, `unknown tool: ${action}`), 403);
      }
      const result = await executeCodeTool(instance, toolName, built.params);
      return c.json(wrapOk(result), result.isError ? 500 : 200);
    });
  }

  return app;
}
