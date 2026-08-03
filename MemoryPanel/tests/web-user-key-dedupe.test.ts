import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../web/src/lib/error-message.ts", () => ({
  formatApiErrorMessage: ({ message }: { message?: string }) =>
    message ?? "API error",
}));

import { userKeysApi } from "../web/src/lib/api/users.js";
import {
  clearPanelSession,
  setPanelSession,
  type PanelSession,
} from "../web/src/lib/panelSession.js";

interface PendingRequest {
  userKey: string;
  resolve: (response: Response) => void;
}

function session(userId: string, userKey: string): PanelSession {
  return {
    instanceId: "instance-1",
    userKey,
    user: {
      user_id: userId,
      auth_provider: "local",
      external_id: userId,
      username: userId,
      status: "active",
      created_at: "2026-08-03T00:00:00.000Z",
      updated_at: "2026-08-03T00:00:00.000Z",
    },
  };
}

function responseFor(userKey: string): Response {
  return new Response(
    JSON.stringify({
      code: 0,
      message: "ok",
      request_id: `request-${userKey}`,
      data: {
        items: [{ key_id: `key-for-${userKey}` }],
        total: 1,
        limit: 100,
        offset: 0,
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

describe("user key request deduplication", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
  });

  afterEach(() => {
    clearPanelSession();
    storage.clear();
    vi.unstubAllGlobals();
  });

  function stubPendingFetch(): {
    pending: PendingRequest[];
    fetchMock: ReturnType<typeof vi.fn>;
  } {
    const pending: PendingRequest[] = [];
    const fetchMock = vi.fn(
      async (
        _input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> =>
        new Promise((resolve) => {
          const headers = init?.headers as Record<string, string>;
          pending.push({
            userKey: headers["X-Tdai-User-Key"],
            resolve,
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return { pending, fetchMock };
  }

  it("does not reuse a pending list across authenticated users", async () => {
    const { pending, fetchMock } = stubPendingFetch();
    setPanelSession(session("user-a", "secret-a"));
    const first = userKeysApi.list();

    setPanelSession(session("user-b", "secret-b"));
    const second = userKeysApi.list();

    for (const request of pending) {
      request.resolve(responseFor(request.userKey));
    }

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(firstResult).toEqual([{ key_id: "key-for-secret-a" }]);
    expect(secondResult).toEqual([{ key_id: "key-for-secret-b" }]);
  });

  it("still reuses a pending list within one authenticated user", async () => {
    const { pending, fetchMock } = stubPendingFetch();
    setPanelSession(session("user-a", "secret-a"));
    const first = userKeysApi.list();
    const second = userKeysApi.list();

    pending[0]?.resolve(responseFor("secret-a"));
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstResult).toEqual([{ key_id: "key-for-secret-a" }]);
    expect(secondResult).toEqual(firstResult);
  });
});
