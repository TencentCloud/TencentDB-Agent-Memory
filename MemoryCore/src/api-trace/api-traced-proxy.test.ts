import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { MetadataError, MetadataService } from "../metadata/service/metadata-service.js";
import {
  DuplicateUserKeyError,
  type IMetadataStore,
} from "../metadata/store/interface.js";
import {
  handleInternalMetaRoute,
  V3_INTERNAL_PREFIX,
} from "../metadata/router/internal-meta-router.js";
import { handleV3MetaRoute, V3_PREFIX } from "../metadata/router/v3-meta-router.js";
import { initApiTraceConfig, resetApiTraceConfigForTests } from "./api-log-config.js";
import { runWithApiRequestContext } from "./api-request-context.js";
import { isApiTraceSensitiveKey, sanitizeApiPayload, summarizeApiError } from "./api-sanitize.js";
import { setStdoutWriterForTests } from "./api-trace-stdout.js";
import { wrapApiServiceForTrace, wrapApiStoreForTrace } from "./api-traced-proxy.js";

const requestContext = {
  requestId: "req-api-trace-redaction",
  route: "/v3/internal/meta/user/init-admin",
  module: "meta",
  internal: true,
};

const secretMessages = ["Authorization=Bearer sk-secret", "api_key=secret-value", "password=secret-value"];

async function requestFailingMetadataRoute(
  service: MetadataService,
  requestId: string,
  internal = false,
  body: Record<string, string> = { user_key: "sk-mem-request-body-secret" },
) {
  const loggerLines: string[] = [];
  const responses: Array<{ status: number; body: unknown }> = [];
  const route = internal ? `${V3_INTERNAL_PREFIX}/user/init-admin` : `${V3_PREFIX}/auth/verify`;
  const handled = await (internal ? handleInternalMetaRoute : handleV3MetaRoute)(
    { headers: { "x-request-id": requestId, "x-tdai-service-id": "instance-router" } } as unknown as IncomingMessage,
    {} as ServerResponse, route, "POST",
    async <T>() => body as T,
    (_res, status, responseBody) => responses.push({ status, body: responseBody }),
    {
      getMetadataService: () => service,
      logger: {
        info() {},
        warn(message) { loggerLines.push(message); },
        error(message) { loggerLines.push(message); },
      },
    },
  );
  return { handled, responses, loggerLines };
}

describe("API trace credential redaction", () => {
  const lines: string[] = [];

  beforeEach(() => {
    lines.length = 0;
    initApiTraceConfig("mongodb");
    setStdoutWriterForTests((line) => lines.push(line));
  });

  afterEach(() => {
    setStdoutWriterForTests(null);
    resetApiTraceConfigForTests();
  });

  it.each(secretMessages)("仅存在于未知异常 message 的凭据不进入 service/store 日志：%s", async (message) => {
    const error = new Error(message);
    const store = wrapApiStoreForTrace({ async createUser() { throw error; } } as unknown as IMetadataStore);
    const service = wrapApiServiceForTrace({ async initAdminUser() { return store.createUser({} as never); } } as unknown as MetadataService);
    await expect(runWithApiRequestContext(requestContext, () => service.initAdminUser({ username: "safe-user" } as never))).rejects.toBe(error);
    const output = lines.join("");
    expect(output).not.toContain(message);
    expect(output).not.toContain("sk-secret");
    expect(output).not.toContain("secret-value");
    for (const context of ["req-api-trace-redaction", "api.store.error", "api.service.error", "source_file", "source_op", "duration_ms", "Error"]) expect(output).toContain(context);
  });

  it.each([false, true].flatMap((internal) => secretMessages.map((message) => ({ internal, message }))))(
    "router 隐藏未知 message 且保持响应 contract：internal=$internal, message=$message", async ({ internal, message }) => {
      const service = {
        async verifyAuthForCaller() { throw new Error(message); },
        async initAdminUser() { throw new Error(message); },
      } as unknown as MetadataService;
      const { responses, loggerLines } = await requestFailingMetadataRoute(
        service, "req-message-only", internal,
        { username: "safe-user", user_key: "sk-mem-request-body-secret" },
      );
      const output = [...lines, ...loggerLines].join("");
      expect(output).not.toContain(message);
      expect(output).not.toContain("sk-secret");
      expect(output).not.toContain("secret-value");
      expect(output).toContain("req-message-only");
      expect(output).toContain("api.http.error");
      expect(responses).toEqual([{ status: 500, body: expect.objectContaining({ code: 500, message: "internal_error", request_id: "req-message-only" }) }]);
    },
  );

  it("不把任意 error name/code 当作安全上下文，业务响应仍保留原内容", async () => {
    const error = Object.assign(new Error("hidden-message"), { name: "Bearer name-secret", code: "api-key-secret" });
    expect(summarizeApiError(error)).not.toMatch(/hidden-message|name-secret|api-key-secret/);
    expect(summarizeApiError("password=primitive-secret")).not.toContain("primitive-secret");
    expect(summarizeApiError(new TypeError("hidden-message"))).toContain("TypeError");
    expect(summarizeApiError(Object.assign(new Error("hidden-message"), { code: 11000 }))).toContain("code=11000");
    const hostile = new Error("hidden-message", { cause: new Error("cause-secret") });
    Object.defineProperty(hostile, "name", { get() { throw new Error("getter-secret"); } });
    expect(summarizeApiError(hostile)).toBe("UnknownError: [redacted]");
    const { responses, loggerLines } = await requestFailingMetadataRoute(
      { async verifyAuthForCaller() { throw new MetadataError("permission_denied", "private-business-message"); } } as unknown as MetadataService,
      "req-business-error",
    );
    expect(responses).toEqual([{ status: 403, body: expect.objectContaining({ code: 403, message: "permission_denied: private-business-message" }) }]);
    expect([...lines, ...loggerLines].join("")).not.toContain("private-business-message");
    expect([...lines, ...loggerLines].join("")).toContain("permission_denied");
  });

  it("redacts snake_case, camelCase, and nested sensitive fields while preserving metadata", () => {
    const nestedUserKey = "nested-user-key-secret";
    const compoundSecrets = {
      "x-api-key": "x-api-key-secret-value",
      clientApiKey: "client-api-key-secret-value",
      providerApiKey: "provider-api-key-camel-secret-value",
      provider_api_key: "provider-api-key-secret-value",
      openaiApiKey: "openai-api-key-camel-secret-value",
      "openai-api-key": "openai-api-key-secret-value",
      clientSecret: "client-secret-camel-value",
      client_secret: "client-secret-snake-value",
      secretKey: "secret-key-camel-value",
      secret_key: "secret-key-snake-value",
      privateKey: "private-key-camel-value",
      private_key: "private-key-snake-value",
      sessionToken: "session-token-camel-value",
      session_token: "session-token-snake-value",
      "csrf-token": "csrf-token-hyphen-value",
    };
    const secrets = {
      user_key: "sk-mem-snake-case-secret",
      userKey: "sk-mem-camel-case-secret",
      api_key: "api-key-snake-secret",
      apiKey: "api-key-camel-secret",
      Authorization: "Bearer authorization-secret",
      authorization: "Bearer lower-authorization-secret",
      token: "top-level-token-secret",
      accessToken: "access-token-secret",
      refreshToken: "refresh-token-secret",
      password: "password-longer-than-eight-characters",
      initial_password: "initial-password-longer-than-eight-characters",
      secret: "top-level-secret",
      key_value: "key-value-secret",
    };
    const payload = {
      ...secrets,
      ...compoundSecrets,
      nested: { userKey: nestedUserKey, clientSecret: "nested-client-secret-value" },
      keyId: "key-id-visible",
      user_id: "usr-visible",
      team_id: "team-visible",
      agent_id: "agent-visible",
      monkey: "monkey-visible",
      publicKey: "public-key-visible",
      accessKeyId: "access-key-id-visible",
      operation: "initAdminUser",
    };

    const serialized = JSON.stringify(sanitizeApiPayload(payload, 1_024));
    const sanitized = sanitizeApiPayload(payload, 1_024) as Record<string, unknown>;

    for (const secret of [...Object.values(secrets), ...Object.values(compoundSecrets)]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain(nestedUserKey);
    expect(serialized).not.toContain("nested-client-secret-value");
    expect(sanitized.user_key).toBe("sk-mem-s…");
    expect(sanitized.userKey).toBe("sk-mem-c…");
    expect(sanitized.password).toBe("[redacted]");
    expect(sanitized.initial_password).toBe("[redacted]");
    expect(sanitized.nested).toEqual({
      userKey: "nested-u…",
      clientSecret: "nested-c…",
    });
    expect(sanitized.keyId).toBe("key-id-visible");
    expect(serialized).toContain("usr-visible");
    expect(serialized).toContain("team-visible");
    expect(serialized).toContain("agent-visible");
    expect(serialized).toContain("monkey-visible");
    expect(serialized).toContain("public-key-visible");
    expect(serialized).toContain("access-key-id-visible");
    expect(serialized).toContain("initAdminUser");
  });

  it("recognizes compound credential names without treating ordinary key/id fields as secrets", () => {
    for (const key of [
      "x-api-key",
      "clientApiKey",
      "providerApiKey",
      "provider_api_key",
      "openaiApiKey",
      "openai-api-key",
      "clientSecret",
      "client_secret",
      "client-secret",
      "secretKey",
      "secret_key",
      "secret-key",
      "privateKey",
      "private_key",
      "private-key",
      "sessionToken",
      "session_token",
      "session-token",
      "csrfToken",
      "csrf_token",
      "csrf-token",
      "databasePassword",
    ]) {
      expect(isApiTraceSensitiveKey(key), key).toBe(true);
    }
    for (const key of [
      "keyId",
      "user_id",
      "team_id",
      "agent_id",
      "monkey",
      "publicKey",
      "accessKeyId",
    ]) {
      expect(isApiTraceSensitiveKey(key), key).toBe(false);
    }
  });

  it("redacts every known primitive credential arg0 operation without hiding ordinary IDs", async () => {
    // 新增首参为裸 credential 的 traced method 时，必须同步更新 operation 白名单与此测试。
    const userKeys = {
      configured: "sk-mem-configured-positional-secret",
      serviceLookup: "sk-mem-service-lookup-positional-secret",
      verify: "sk-mem-verify-positional-secret",
      verifyForCaller: "sk-mem-verify-caller-positional-secret",
      storeLookup: "sk-mem-store-lookup-positional-secret",
    };
    const service = {
      isConfiguredMemorySystemUserKey(): boolean {
        return false;
      },
      async getUserByKey(): Promise<null> {
        return null;
      },
      async verifyAuth(): Promise<null> {
        return null;
      },
      async verifyAuthForCaller(): Promise<{ valid: false; user: null }> {
        return { valid: false, user: null };
      },
    } as unknown as MetadataService;
    const store = {
      async getUserByKey(): Promise<null> {
        return null;
      },
      async getUserById(): Promise<null> {
        return null;
      },
    } as unknown as IMetadataStore;
    const tracedService = wrapApiServiceForTrace(service);
    const tracedStore = wrapApiStoreForTrace(store);

    await runWithApiRequestContext(requestContext, async () => {
      tracedService.isConfiguredMemorySystemUserKey(userKeys.configured);
      await tracedService.getUserByKey(userKeys.serviceLookup);
      await tracedService.verifyAuth(userKeys.verify);
      await tracedService.verifyAuthForCaller(userKeys.verifyForCaller, {
        token: "",
        isAdmin: false,
        isSystemAdmin: false,
      });
      await tracedStore.getUserByKey(userKeys.storeLookup);
      await tracedStore.getUserById("usr-positional-visible");
    });

    const output = lines.join("");
    for (const userKey of Object.values(userKeys)) {
      expect(output).not.toContain(userKey);
    }
    expect(output).toContain("usr-positional-visible");
  });

  it("redacts a real initAdminUser duplicate-key failure through the internal router catch", async () => {
    const userKey = "sk-mem-real-init-admin-duplicate-secret";
    const store = {
      async countUsers(): Promise<number> {
        return 0;
      },
      async countSystemAdmins(): Promise<number> {
        return 0;
      },
      async createUser(): Promise<never> {
        const error = new DuplicateUserKeyError(userKey);
        error.message = `user_key already exists: ${userKey}`;
        throw error;
      },
    } as unknown as IMetadataStore;
    const service = wrapApiServiceForTrace(
      new MetadataService(wrapApiStoreForTrace(store), "instance-router"),
    );
    const { handled, responses, loggerLines } = await requestFailingMetadataRoute(
      service, "req-init-admin-duplicate", true,
      { username: "admin-visible", user_key: userKey },
    );

    const output = [...lines, ...loggerLines].join("");
    expect(handled).toBe(true);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.status).toBe(500);
    expect(output).not.toContain(userKey);
    expect(output).toContain("api.store.error");
    expect(output).toContain("api.service.error");
    expect(output).toContain("api.http.error");
    expect(output).toContain("[META-V3-INTERNAL] unexpected:");
  });

  it("redacts sensitive error messages at the public v3 router logger boundary", async () => {
    const clientSecret = "public-router-client-secret-value";
    const password = "public-router-password-longer-than-eight";
    const service = {
      async verifyAuthForCaller(): Promise<never> {
        const error = new Error(
          `upstream failed with client secret ${clientSecret} and password ${password}`,
        ) as Error & {
          clientSecret: string;
          password: string;
        };
        error.clientSecret = clientSecret;
        error.password = password;
        throw error;
      },
    } as unknown as MetadataService;
    const { loggerLines } = await requestFailingMetadataRoute(
      service, "req-public-router-error",
    );

    const output = [...lines, ...loggerLines].join("");
    expect(output).not.toContain(clientSecret);
    expect(output).not.toContain(password);
    expect(output).toContain("[redacted]");
    expect(output).toContain("api.http.error");
    expect(output).toContain("[META-V3]");
  });

  it("redacts DuplicateUserKeyError key material from store error traces", async () => {
    const userKey = "sk-mem-duplicate-key-error-secret";
    const store = {
      async createUser(): Promise<never> {
        throw new DuplicateUserKeyError(userKey);
      },
    } as unknown as IMetadataStore;
    const traced = wrapApiStoreForTrace(store);

    await expect(
      runWithApiRequestContext(requestContext, () =>
        traced.createUser({
          user_id: "usr-duplicate-visible",
          username: "duplicate-visible",
          auth_provider: "local",
          external_id: "usr-duplicate-visible",
          default_key_value: userKey,
        }),
      ),
    ).rejects.toBeInstanceOf(DuplicateUserKeyError);

    const output = lines.join("");
    expect(new DuplicateUserKeyError(userKey).message).toBe("user_key already exists");
    expect(output).not.toContain(userKey);
    expect(output).toContain("api.store.error");
    expect(output).toContain("usr-duplicate-visible");
    expect(output).toContain("duplicate-visible");
  });
});
