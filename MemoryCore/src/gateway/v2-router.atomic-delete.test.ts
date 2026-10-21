import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { handleV2Route } from "./v2-router.js";
import type { IMemoryStore } from "../core/store/types.js";

type DeleteStore = Pick<IMemoryStore, "deleteL1"> & {
  appendAudit: ReturnType<typeof vi.fn>;
};

function makeStore(deleteL1: IMemoryStore["deleteL1"]): DeleteStore {
  return {
    deleteL1,
    appendAudit: vi.fn(),
  } as unknown as DeleteStore;
}

async function invoke(store: DeleteStore, quotaManager?: { reportMemoryDeleted: ReturnType<typeof vi.fn> }) {
  const sent: { status: number; body: any }[] = [];
  const req = {
    method: "POST",
    url: "/v2/atomic/delete",
    headers: {
      authorization: "Bearer test-key",
      "x-tdai-service-id": "test-service",
    },
  } as unknown as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  await handleV2Route(
    req,
    res,
    "/v2/atomic/delete",
    "POST",
    async () => ({ ids: ["memory-1"] }),
    (_res, status, body) => sent.push({ status, body }),
    {
      getStore: () => store as unknown as IMemoryStore,
      getEmbedding: () => undefined,
      getStorage: () => undefined,
      logger: logger as never,
      deployMode: "standalone",
      quotaManager: quotaManager as never,
    },
  );

  return sent[0];
}

describe("/v2/atomic/delete", () => {
  it("returns 502 without audit or quota side effects when storage fails", async () => {
    const deleteL1 = vi.fn().mockRejectedValue(new Error("backend unavailable"));
    const store = makeStore(deleteL1);
    const quotaManager = { reportMemoryDeleted: vi.fn() };

    const response = await invoke(store, quotaManager);

    expect(response.status).toBe(502);
    expect(response.body.code).toBe(502);
    expect(deleteL1).toHaveBeenCalledWith(
      "memory-1",
      { userId: "default", agentId: "default" },
      { throwOnError: true },
    );
    expect(store.appendAudit).not.toHaveBeenCalled();
    expect(quotaManager.reportMemoryDeleted).not.toHaveBeenCalled();
  });

  it("keeps a missing record as a successful zero-count delete", async () => {
    const store = makeStore(vi.fn().mockResolvedValue(false));
    const quotaManager = { reportMemoryDeleted: vi.fn() };

    const response = await invoke(store, quotaManager);

    expect(response.status).toBe(200);
    expect(response.body.data.deleted_count).toBe(0);
    expect(store.appendAudit).not.toHaveBeenCalled();
    expect(quotaManager.reportMemoryDeleted).not.toHaveBeenCalled();
  });

  it("audits and reports a successful delete", async () => {
    const store = makeStore(vi.fn().mockResolvedValue(true));
    const quotaManager = { reportMemoryDeleted: vi.fn().mockResolvedValue(undefined) };

    const response = await invoke(store, quotaManager);

    expect(response.status).toBe(200);
    expect(response.body.data.deleted_count).toBe(1);
    expect(store.appendAudit).toHaveBeenCalledOnce();
    expect(quotaManager.reportMemoryDeleted).toHaveBeenCalledWith("test-service", 1);
  });
});
