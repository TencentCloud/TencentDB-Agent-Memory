import { Hono, type Context } from "hono";
import { describe, expect, it } from "vitest";

import type { ProxyConfig } from "../../types.js";
import { createSessionForceArchiveHandler } from "../session-force-archive.js";
import { createSessionRefreshHandler } from "../session-refresh.js";

const routes = [
  {
    path: "/v3/session/refresh-cache",
    createHandler: createSessionRefreshHandler,
  },
  {
    path: "/v3/session/force-archive-skill",
    createHandler: createSessionForceArchiveHandler,
  },
] as const;

type HandlerFactory = (config: ProxyConfig) => (c: Context) => Promise<Response>;

function appFor(
  path: string,
  createHandler: HandlerFactory,
  apiKey: string,
): Hono {
  const app = new Hono();
  const handler = createHandler({
    admin: { apiKey },
  } as ProxyConfig);
  app.post(path, handler);
  return app;
}

describe.each(routes)("$path admin auth", ({ path, createHandler }) => {
  it("rejects a missing token before parsing the request", async () => {
    const response = await appFor(path, createHandler, "admin-secret").request(
      path,
      {
        method: "POST",
        body: "{not-json",
      },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      code: 401,
      message: "Unauthorized: missing Bearer token",
    });
  });

  it("rejects an invalid token", async () => {
    const response = await appFor(path, createHandler, "admin-secret").request(
      path,
      {
        method: "POST",
        headers: { authorization: "Bearer wrong-secret" },
        body: "{not-json",
      },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      code: 401,
      message: "Unauthorized: invalid token",
    });
  });

  it("allows the configured token to reach request validation", async () => {
    const response = await appFor(path, createHandler, "admin-secret").request(
      path,
      {
        method: "POST",
        headers: { authorization: "Bearer admin-secret" },
        body: "{not-json",
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 40001,
      message: "Invalid JSON body",
    });
  });

  it("preserves the existing open behavior when no key is configured", async () => {
    const response = await appFor(path, createHandler, "").request(path, {
      method: "POST",
      body: "{not-json",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 40001,
      message: "Invalid JSON body",
    });
  });
});
