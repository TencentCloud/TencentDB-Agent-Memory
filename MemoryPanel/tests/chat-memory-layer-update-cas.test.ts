import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { PanelDeps } from "../src/panel/panel-deps.js";
import { registerChatMemoryRoutes } from "../src/panel/http/routes/chat-memory.js";

const endpoint = "/chat-memory/layer-update";
const headers = {
  "Content-Type": "application/json",
  "X-Tdai-Service-Id": "instance-1",
  "X-Tdai-User-Key": "user-key-1",
};
const baseBody = {
  block_id: "chat_memory-team-1-agt1",
  layer: "L1",
  id: "memory-1",
  content: "edited content",
};

function makeApp(kernelEnvelope: Record<string, unknown> = {
  code: 0,
  message: "ok",
  request_id: "kernel-request-1",
  data: { id: "memory-1", version: "v4" },
}) {
  const postEnvelope = vi.fn().mockResolvedValue(kernelEnvelope);
  const invoke = vi.fn(async (action: string) => {
    if (action === "auth/verify") {
      return {
        code: 0,
        message: "ok",
        request_id: "meta-request-1",
        data: { valid: true, user: { user_id: "user-1" } },
      };
    }
    if (action === "asset/get") {
      return {
        code: 0,
        message: "ok",
        request_id: "meta-request-2",
        data: {
          asset_id: baseBody.block_id,
          asset_type: "chat_memory",
          owner_user_id: "user-1",
        },
      };
    }
    throw new Error(`unexpected meta action: ${action}`);
  });
  const deps = {
    instanceRegistry: {
      resolve: vi.fn().mockReturnValue({
        instance_id: "instance-1",
        gateway_endpoint: "http://memory.test",
        api_key: "gateway-key",
      }),
    },
    metaKernel: { invoke },
    kernelHttp: { postEnvelope },
  } as unknown as PanelDeps;
  const app = new Hono();
  registerChatMemoryRoutes(app, deps);
  return { app, invoke, postEnvelope };
}

async function post(app: Hono, body: Record<string, unknown>) {
  const response = await app.request(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}

describe("chat-memory layer-update expected_version", () => {
  it("forwards a valid L1 compare-and-swap guard to MemoryCore", async () => {
    const { app, postEnvelope } = makeApp();

    const response = await post(app, { ...baseBody, expected_version: 3 });

    expect(response.status).toBe(200);
    expect(postEnvelope).toHaveBeenCalledWith(
      "/v3/atomic/update",
      expect.objectContaining({
        id: "memory-1",
        content: "edited content",
        expected_version: 3,
      }),
      expect.any(Object),
    );
  });

  it("preserves a MemoryCore 409 conflict envelope and status", async () => {
    const { app } = makeApp({
      code: 409,
      message: "ATOMIC_VERSION_CONFLICT",
      request_id: "kernel-request-2",
      data: {
        error_code: "ATOMIC_VERSION_CONFLICT",
        expected_version: 3,
        current_version: 4,
      },
    });

    const response = await post(app, { ...baseBody, expected_version: 3 });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 409,
      message: "ATOMIC_VERSION_CONFLICT",
      data: { expected_version: 3, current_version: 4 },
    });
  });

  it("rejects unsafe versions before authorization or kernel calls", async () => {
    const { app, invoke, postEnvelope } = makeApp();

    const response = await post(app, {
      ...baseBody,
      expected_version: Number.MAX_SAFE_INTEGER,
    });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe("INVALID_EXPECTED_VERSION");
    expect(invoke).not.toHaveBeenCalled();
    expect(postEnvelope).not.toHaveBeenCalled();
  });

  it("rejects expected_version on non-L1 edits", async () => {
    const { app, invoke, postEnvelope } = makeApp();

    const response = await post(app, {
      ...baseBody,
      layer: "L2",
      expected_version: 3,
    });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe("EXPECTED_VERSION_REQUIRES_L1");
    expect(invoke).not.toHaveBeenCalled();
    expect(postEnvelope).not.toHaveBeenCalled();
  });
});
