import { describe, expect, it, vi } from "vitest";
import type { IMemoryStore, L1RecordRow } from "../core/store/types.js";
import { handleV2Route, type V2RouterDeps } from "./v2-router.js";

const requestBody = {
  team_id: "team-1",
  agent_id: "agent-1",
  user_id: "user-1",
  session_id: "session-1",
  id: "memory-1",
  content: "edited content",
};

function record(version: number): L1RecordRow {
  return {
    record_id: "memory-1",
    content: "original content",
    type: "persona",
    priority: 50,
    scene_name: "default",
    metadata_json: "{}",
    timestamp_str: "",
    timestamp_start: "",
    timestamp_end: "",
    created_time: "2026-09-01T00:00:00.000Z",
    updated_time: "2026-09-01T00:00:00.000Z",
    version,
    session_key: "session-key",
    session_id: "session-1",
    team_id: "team-1",
    task_id: "",
    user_id: "user-1",
    agent_id: "agent-1",
  };
}

function makeStore(version: number) {
  return {
    queryL1Records: vi.fn().mockResolvedValue([record(version)]),
    upsertL1: vi.fn().mockResolvedValue(true),
    compareAndSwapL1: vi.fn(),
  };
}

async function dispatch(
  body: Record<string, unknown>,
  store: ReturnType<typeof makeStore>,
): Promise<{ status: number; body: any }> {
  let response: { status: number; body: any } | undefined;
  const req = {
    headers: {
      authorization: "Bearer test-key",
      "x-tdai-service-id": "service-1",
    },
    url: "/v3/atomic/update",
  } as any;
  const res = {} as any;
  const deps: V2RouterDeps = {
    getStore: () => store as unknown as IMemoryStore,
    getEmbedding: () => undefined,
    getStorage: () => undefined,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    deployMode: "standalone",
  };

  const handled = await handleV2Route(
    req,
    res,
    "/v3/atomic/update",
    "POST",
    async <T,>() => body as T,
    (_res, status, envelope) => {
      response = { status, body: envelope };
    },
    deps,
  );

  expect(handled).toBe(true);
  expect(response).toBeDefined();
  return response!;
}

describe("POST /v3/atomic/update expected_version", () => {
  it("returns 409 with a stable error code and current version for a stale edit", async () => {
    const store = makeStore(4);
    store.compareAndSwapL1.mockResolvedValue({ status: "conflict", currentVersion: 4 });

    const response = await dispatch({ ...requestBody, expected_version: 3 }, store);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 409,
      message: "ATOMIC_VERSION_CONFLICT",
      data: {
        error_code: "ATOMIC_VERSION_CONFLICT",
        expected_version: 3,
        current_version: 4,
      },
    });
    expect(store.upsertL1).not.toHaveBeenCalled();
    expect(store.compareAndSwapL1).toHaveBeenCalledTimes(1);
  });

  it("uses CAS for a fresh edit and returns the incremented version", async () => {
    const store = makeStore(3);
    store.compareAndSwapL1.mockResolvedValue({ status: "updated" });

    const response = await dispatch({ ...requestBody, expected_version: 3 }, store);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      code: 0,
      data: { id: "memory-1", version: "v4" },
    });
    const [written, expectedVersion] = store.compareAndSwapL1.mock.calls[0];
    expect(expectedVersion).toBe(3);
    expect(written).toMatchObject({ content: "edited content", version: 4 });
  });

  it("preserves legacy last-write-wins behavior when expected_version is omitted", async () => {
    const store = makeStore(7);

    const response = await dispatch(requestBody, store);

    expect(response.status).toBe(200);
    expect(response.body.data.version).toBe("v8");
    expect(store.upsertL1).toHaveBeenCalledTimes(1);
    expect(store.compareAndSwapL1).not.toHaveBeenCalled();
  });

  it("rejects a version whose increment would exceed the safe-integer range", async () => {
    const store = makeStore(3);

    const response = await dispatch(
      { ...requestBody, expected_version: Number.MAX_SAFE_INTEGER },
      store,
    );

    expect(response.status).toBe(400);
    expect(store.upsertL1).not.toHaveBeenCalled();
    expect(store.compareAndSwapL1).not.toHaveBeenCalled();
  });

  it("returns 404 when the record disappears during the guarded update", async () => {
    const store = makeStore(3);
    store.compareAndSwapL1.mockResolvedValue({ status: "not_found" });

    const response = await dispatch({ ...requestBody, expected_version: 3 }, store);

    expect(response.status).toBe(404);
    expect(response.body.message).toBe("Atomic note not found: memory-1");
  });

  it("returns 503 when guarded updates are unsupported by the store", async () => {
    const store = makeStore(3);
    (store as { compareAndSwapL1?: unknown }).compareAndSwapL1 = undefined;

    const response = await dispatch({ ...requestBody, expected_version: 3 }, store);

    expect(response.status).toBe(503);
    expect(response.body.message).toBe("ATOMIC_CAS_UNSUPPORTED");
    expect(store.upsertL1).not.toHaveBeenCalled();
  });

  it("returns 500 when a guarded persistence operation fails", async () => {
    const store = makeStore(3);
    store.compareAndSwapL1.mockResolvedValue({ status: "failed" });

    const response = await dispatch({ ...requestBody, expected_version: 3 }, store);

    expect(response.status).toBe(500);
    expect(response.body.message).toBe("ATOMIC_UPDATE_FAILED");
    expect(store.upsertL1).not.toHaveBeenCalled();
  });
});
