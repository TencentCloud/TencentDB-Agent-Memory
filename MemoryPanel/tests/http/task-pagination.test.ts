import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { InstanceRegistry } from "../../src/panel/config/instance-registry.js";
import { registerTaskRoutes } from "../../src/panel/http/routes/task.js";
import type { PanelDeps } from "../../src/panel/panel-deps.js";

describe("task list aggregation pagination", () => {
  it("returns pagination metadata normalized by the kernel", async () => {
    const invoke = vi.fn(async (action: string) => {
      if (action === "task/list") {
        return {
          code: 0,
          message: "ok",
          request_id: "kernel-list",
          data: {
            items: [
              {
                task_id: "task-1",
                team_id: "team-1",
                title: "Task",
                status: "active",
                created_at: "2026-08-03T00:00:00.000Z",
                updated_at: "2026-08-03T00:00:00.000Z",
              },
            ],
            total: 42,
            limit: 20,
            offset: 40,
          },
        };
      }
      return {
        code: 0,
        message: "ok",
        request_id: "kernel-agents",
        data: { items: [] },
      };
    });
    const deps = {
      instanceRegistry: new InstanceRegistry([
        {
          instance_id: "default",
          name: "Default",
          gateway_endpoint: "http://gateway.test",
          api_key: "gateway-key",
        },
      ]),
      metaKernel: { invoke },
    } as unknown as PanelDeps;
    const app = new Hono();
    registerTaskRoutes(app, deps);

    const response = await app.request("/task/list-with-agents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-tdai-service-id": "default",
        "x-tdai-user-key": "user-key",
      },
      body: JSON.stringify({
        team_id: "team-1",
        limit: 500,
        offset: 10,
      }),
    });
    const envelope = await response.json();

    expect(response.status).toBe(200);
    expect(envelope.data).toMatchObject({
      total: 42,
      limit: 20,
      offset: 40,
    });
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      "task/list",
      { team_id: "team-1", limit: 200, offset: 10 },
      expect.objectContaining({
        instanceId: "default",
        userKey: "user-key",
      }),
    );
  });
});
