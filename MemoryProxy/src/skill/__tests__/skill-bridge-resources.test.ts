import { execFileSync } from "node:child_process";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProxyConfig } from "../../types.js";
import { __resetSessionStoreForTests, getSessionStore } from "../../session/store.js";
import { __resetProxyStorageForTests, getProxyStorage } from "../../storage/factory.js";
import { KvVersionPinRepo } from "../kv-version-pin-repo.js";
import { createSkillBridgeHandler } from "../skill-bridge.js";
import { renderSkillResult } from "../selection/query.js";

const target = { skill_id: "skl-externalized", version: 7 };
const content = "Read [the full guide](references/full-guide.md) with skill_files_read.";
const manifest = [{ path: "references/full-guide.md" }, { path: "scripts/check.py" }];

async function setup(options: {
  manifest?: unknown;
  externalGatewayUrl?: string;
  sessionId?: string;
  spaceId?: string;
  parentId?: string;
  status?: number;
  coreBody?: string;
  pinnedVersion?: number;
  pins?: Array<{ skillId: string; version: number }>;
  fetcherImpl?: typeof fetch;
} = {}) {
  const sessionId = options.sessionId ?? "session-current";
  const spaceId = options.spaceId ?? "tenant-current";
  const keyId = options.parentId ?? sessionId;
  await getSessionStore().set(keyId, {
    keyId, status: "initialized", startedAt: Date.now(), attemptCount: 0,
    sessionInfo: {
      session_id: keyId, user_id: "user-current", team_id: "team-current",
      agent_id: "agent-current", space_id: spaceId, user_key: "private-user-key",
    },
  });
  const config = {
    coreSkill: { endpoint: "http://private-core", serviceToken: "private-service-token", serviceId: "tenant-config", timeoutMs: 1000 },
    injection: { externalGatewayUrl: options.externalGatewayUrl },
    skillRuntime: { allowLlmWrite: false },
    ...(options.pinnedVersion === undefined && !options.pins ? {} : { storage: { enabled: true, backend: "memory", ttlDays: 0 } }),
  } as ProxyConfig;
  if (options.pinnedVersion !== undefined || options.pins) {
    const pins = new KvVersionPinRepo(getProxyStorage(config.storage!));
    await pins.pinMany(spaceId, "user-current", "claude-code", keyId, options.pins ?? [{ skillId: target.skill_id, version: options.pinnedVersion! }]);
  }
  const fetcher = vi.fn<typeof fetch>(options.fetcherImpl ?? (async (url, init) => {
    if (String(url).endsWith("/files/read")) {
      const request = JSON.parse(String(init?.body));
      return Response.json({ code: 0, data: { path: request.path, version: request.version, content: "Full guide only read on demand", encoding: "utf-8" } });
    }
    return new Response(options.coreBody ?? JSON.stringify({
      code: 0, data: { ...target, name: "Externalized guide", content, manifest: options.manifest },
    }), { status: options.status ?? 200, headers: { "content-type": "application/json" } });
  }));
  const app = new Hono();
  app.all("/skill-bridge/*", createSkillBridgeHandler(config, { fetcher }));
  const headers = {
    "content-type": "application/json", "x-conversation-id": sessionId,
    "x-tdai-service-id": spaceId,
    ...(options.parentId ? { "x-parent-conversation-id": options.parentId } : {}),
  };
  const raw = () => app.request("https://proxy.example/skill-bridge/v3/skill/raw", {
    method: "POST", headers,
    body: JSON.stringify({ ...target, user_id: "forged", team_id: "forged", agent_id: "forged", include_manifest: false }),
  });
  return { app, fetcher, raw, headers };
}

// Execute only the generated recipe; curl is replaced by an argv printer, so no network is used.
function recipeArgs(text: string): string[] {
  const recipe = text.match(/```(?:bash|sh)\n([\s\S]*?)\n```/)?.[1];
  expect(recipe, "resource-bearing raw must contain an executable read recipe").toBeTruthy();
  const output = execFileSync("bash", ["--noprofile", "--norc", "-c", `curl() { printf '%s\\0' "$@"; }\n${recipe}`], { encoding: "utf8" });
  return output.split("\0").slice(0, -1);
}

function recipeRequest(args: string[]) {
  const headers = new Headers();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-H") {
      const header = args[++i];
      const colon = header.indexOf(":");
      headers.set(header.slice(0, colon), header.slice(colon + 1).trim());
    }
  }
  const dataIndex = args.findIndex((arg) => arg === "-d" || arg === "--data-raw");
  expect(dataIndex).toBeGreaterThan(-1);
  return { headers, body: args[dataIndex + 1] };
}

beforeEach(() => {
  __resetSessionStoreForTests();
  __resetProxyStorageForTests();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  __resetSessionStoreForTests();
  __resetProxyStorageForTests();
  vi.restoreAllMocks();
});

describe("selection raw resource reads", () => {
  it("requests the manifest at the explicit selected version and stamps session identity", async () => {
    const { raw, fetcher } = await setup();
    await raw();
    expect(fetcher.mock.calls[0][0]).toBe("http://private-core/v3/skill/get");
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      ...target, include_content: true, include_manifest: true,
      user_id: "user-current", team_id: "team-current", agent_id: "agent-current",
    });
  });

  it("adds only manifest paths and one read-only recipe, without credentials or resource contents", async () => {
    const { raw, fetcher } = await setup({ manifest });
    const response = await raw();
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain(content);
    for (const { path } of manifest) expect(text).toContain(path);
    expect(text).toContain("skill_files_read");
    expect(text).toContain("data.version");
    expect(text).not.toMatch(/private-user-key|private-service-token|Authorization|files\/write|files\/remove/);
    expect(text).not.toContain("Full guide only read on demand");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const args = recipeArgs(text);
    expect(args).toContain("https://proxy.example/skill-bridge/v3/skill/files/read");
    const read = recipeRequest(args);
    expect(read.headers.get("x-conversation-id")).toBe("session-current");
    expect(read.headers.get("x-tdai-service-id")).toBe("tenant-current");
    expect(JSON.parse(read.body)).toMatchObject({ ...target, path: manifest[0].path });
  });

  it("round-trips the recipe through files/read with the same skill, version and session identity", async () => {
    const { raw, app, fetcher } = await setup({ manifest });
    const args = recipeArgs(await (await raw()).text());
    const response = await app.request("https://proxy.example/skill-bridge/v3/skill/files/read", {
      method: "POST", ...recipeRequest(args),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).data.content).toBe("Full guide only read on demand");
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toMatchObject({
      ...target, path: manifest[0].path, user_id: "user-current", team_id: "team-current", agent_id: "agent-current",
    });
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).get("x-tdai-service-id")).toBe("tenant-current");
  });

  it("reads the raw version even with an older session pin, without advancing that pin", async () => {
    const { raw, app, headers } = await setup({ manifest, pinnedVersion: 1 });
    const text = await (await raw()).text();
    expect(text).toContain('version="7"');
    const response = await app.request("https://proxy.example/skill-bridge/v3/skill/files/read", {
      method: "POST", ...recipeRequest(recipeArgs(text)),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).data.version).toBe(7);

    const pinnedRead = await app.request("https://proxy.example/skill-bridge/v3/skill/files/read", {
      method: "POST", headers, body: JSON.stringify({ skill_id: target.skill_id, path: manifest[0].path }),
    });
    expect((await pinnedRead.json()).data.version).toBe(1);
  });

  it.each([undefined, 0, -1, 1.5, "7", null])("retains the pin for files/read without a valid explicit version (%j)", async (version) => {
    const { app, headers } = await setup({ pinnedVersion: 1 });
    const response = await app.request("https://proxy.example/skill-bridge/v3/skill/files/read", {
      method: "POST", headers, body: JSON.stringify({ skill_id: target.skill_id, version, path: manifest[0].path }),
    });
    expect((await response.json()).data.version).toBe(1);
  });

  it("leaves get's existing pin precedence unchanged", async () => {
    const { app, headers, fetcher } = await setup({ pinnedVersion: 1 });
    await app.request("https://proxy.example/skill-bridge/v3/skill/get", {
      method: "POST", headers, body: JSON.stringify(target),
    });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).version).toBe(1);
  });

  it("prefers the external gateway path but never copies URL credentials, query or fragment", async () => {
    const { raw } = await setup({ manifest, externalGatewayUrl: "https://url-user:url-secret@gateway.example/proxy/?token=query-secret#fragment-secret" });
    const text = await (await raw()).text();
    expect(recipeArgs(text)).toContain("https://gateway.example/proxy/skill-bridge/v3/skill/files/read");
    expect(text).not.toMatch(/url-user|url-secret|query-secret|fragment-secret|proxy\.example/);
  });

  it.each(["not-a-url", "file:///private/path", ""])("falls back to the request origin for an unusable external gateway (%s)", async (externalGatewayUrl) => {
    const { raw } = await setup({ manifest, externalGatewayUrl });
    expect(recipeArgs(await (await raw()).text())).toContain("https://proxy.example/skill-bridge/v3/skill/files/read");
  });

  it("shell-quotes paths, gateway paths and session/tenant headers without expansion", async () => {
    const path = "references/guide's $(printf injected) `printf injected` \\\".md";
    const sessionId = "session'$(printf injected)`printf injected`";
    const spaceId = "tenant'$(printf injected)`printf injected`";
    const { raw } = await setup({ manifest: [{ path }], sessionId, spaceId, externalGatewayUrl: "https://gateway.example/proxy'$(printf%20injected)/" });
    const args = recipeArgs(await (await raw()).text());
    expect(args).toContain("https://gateway.example/proxy'$(printf%20injected)/skill-bridge/v3/skill/files/read");
    const read = recipeRequest(args);
    expect(read.headers.get("x-conversation-id")).toBe(sessionId);
    expect(read.headers.get("x-tdai-service-id")).toBe(spaceId);
    expect(JSON.parse(read.body)).toMatchObject({ ...target, path });
  });

  it("uses the resolved parent conversation rather than the child header", async () => {
    const { raw } = await setup({ manifest, parentId: "parent-session" });
    const read = recipeRequest(recipeArgs(await (await raw()).text()));
    expect(read.headers.get("x-conversation-id")).toBe("parent-session");
  });

  it.each([undefined, [], null, [{ size_bytes: 10 }]])("keeps resource-free raw output byte-compatible (%j)", async (resourceManifest) => {
    const { raw } = await setup({ manifest: resourceManifest });
    const response = await raw();
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await response.text()).toBe([
      '<loaded_skill id="skl-externalized" version="7" name="Externalized guide">',
      renderSkillResult("Externalized guide", content), "</loaded_skill>", "",
    ].join("\n"));
  });

  it.each([
    { status: 403, coreBody: '{"code":40301,"message":"forbidden"}', expected: 403 },
    { status: 200, coreBody: '{"code":40401,"message":"not found"}', expected: 502 },
    { status: 200, coreBody: "not JSON", expected: 502 },
  ])("preserves upstream error bodies and emits no recipe ($expected)", async (options) => {
    const { raw } = await setup(options);
    const response = await raw();
    expect(response.status).toBe(options.expected);
    expect(await response.text()).toBe(options.coreBody);
  });

  it.each([
    { skill_id: "skl-other", version: 7 },
    { skill_id: target.skill_id, version: 8 },
    { skill_id: target.skill_id },
  ])("rejects a mismatched upstream resource snapshot (%j)", async (snapshot) => {
    const { raw } = await setup({ coreBody: JSON.stringify({ code: 0, data: { ...snapshot, content, manifest } }) });
    const response = await raw();
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("<loaded_skill");
  });

  it("does not enable writes or bypass session initialization", async () => {
    const { app, headers, fetcher } = await setup({ manifest });
    const write = await app.request("https://proxy.example/skill-bridge/v3/skill/files/write", { method: "POST", headers, body: "{}" });
    expect(write.status).toBe(403);
    const read = await app.request("https://proxy.example/skill-bridge/v3/skill/files/read", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(target),
    });
    expect(read.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

const parent = { skill_id: "skl-parent", version: 12 };
const child = { skill_id: "skl-child", name: "Independent guide", description: "Read when diagnosing databases" };
const restructure = { schema_version: 1, children: [child] };

async function childSetup(options: Parameters<typeof setup>[0] & {
  navigation?: unknown;
  childSnapshot?: Record<string, unknown>;
  childError?: { status: number; code: number };
} = {}) {
  let childHead = 1;
  const fixture = await setup({ ...options, fetcherImpl: async (url, init) => {
    const request = JSON.parse(String(init?.body));
    if (String(url).endsWith("/files/read")) {
      return Response.json({ code: 0, data: { path: request.path, version: request.version, encoding: "utf-8", content: `child resource v${request.version}` } });
    }
    if (request.skill_id === parent.skill_id) return Response.json({ code: 0, data: {
      ...parent, name: "Parent navigation", content: `Load ${child.skill_id} when needed.`,
      metadata: { __skill_restructure: options.navigation ?? restructure },
    } });
    if (options.childError) return Response.json({ code: options.childError.code, message: "child inaccessible" }, { status: options.childError.status });
    return Response.json({ code: 0, data: {
      ...child, version: request.version ?? childHead, content: `Independent child body v${request.version ?? childHead}`,
      manifest: [{ path: "references/child.txt" }], ...options.childSnapshot,
    } });
  } });
  const request = (sub: string, body: Record<string, unknown>) => fixture.app.request(`https://proxy.example/skill-bridge/v3/skill/${sub}`, {
    method: "POST", headers: fixture.headers, body: JSON.stringify(body),
  });
  const follow = (text: string) => {
    const args = recipeArgs(text);
    const url = args.find(arg => /^https?:\/\//.test(arg))!;
    return fixture.app.request(url, { method: "POST", ...recipeRequest(args) });
  };
  return { ...fixture, request, follow, advanceChild: () => { childHead++; } };
}

describe("selection independently versioned child reads", () => {
  it("round-trips parent v12 navigation through child get v1 and child files/read v1", async () => {
    const { request, follow, fetcher } = await childSetup();
    const parentText = await (await request("raw", parent)).text();
    expect(parentText).toContain(child.skill_id);
    expect(parentText).not.toContain("Independent child body");
    const navigation = recipeRequest(recipeArgs(parentText));
    expect(JSON.parse(navigation.body)).toEqual({ skill_id: child.skill_id, render_raw: true });
    const childResponse = await follow(parentText);
    expect(childResponse.headers.get("content-type")).toContain("text/markdown");
    const childText = await childResponse.text();
    expect(childText).toContain('<loaded_skill id="skl-child" version="1"');
    expect(childText).toContain("Independent child body v1");
    expect(JSON.parse(recipeRequest(recipeArgs(childText)).body)).toMatchObject({ skill_id: child.skill_id, version: 1 });
    const resource = await follow(childText);
    expect((await resource.json()).data.content).toBe("child resource v1");
    const bodies = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies[1]).toMatchObject({ skill_id: child.skill_id, include_content: true, include_manifest: true,
      user_id: "user-current", team_id: "team-current", agent_id: "agent-current" });
    expect(bodies[1]).not.toHaveProperty("render_raw");
    expect(bodies[1]).not.toHaveProperty("version");
    expect(bodies[2]).toMatchObject({ skill_id: child.skill_id, version: 1 });
    for (const [, init] of fetcher.mock.calls) expect(new Headers(init?.headers).get("x-tdai-service-id")).toBe("tenant-current");
  });

  it("loads child v2 without republishing parent v12 when no child pin exists", async () => {
    const { request, follow, advanceChild } = await childSetup();
    const parentText = await (await request("raw", parent)).text();
    expect(await (await follow(parentText)).text()).toContain('version="1"');
    advanceChild();
    const childText = await (await follow(parentText)).text();
    expect(childText).toContain('version="2"');
    expect((await (await follow(childText)).json()).data.content).toBe("child resource v2");
    expect(await (await request("raw", parent)).text()).toBe(parentText);
  });

  it("keeps independently pinned parent and child versions separate, including after child head advances", async () => {
    const { request, follow, advanceChild, fetcher } = await childSetup({ pins: [
      { skillId: parent.skill_id, version: 12 }, { skillId: child.skill_id, version: 1 },
    ] });
    advanceChild();
    const parentText = await (await request("raw", parent)).text();
    const childText = await (await follow(parentText)).text();
    expect(childText).toContain('<loaded_skill id="skl-child" version="1"');
    expect((await (await follow(childText)).json()).data.version).toBe(1);
    await request("get", { skill_id: parent.skill_id });
    expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body)).version).toBe(12);
  });

  it("lazy-pins a validated first child load without inheriting the parent pin", async () => {
    const { request, advanceChild, fetcher } = await childSetup({ pins: [{ skillId: parent.skill_id, version: 12 }] });
    const first = await request("get", { skill_id: child.skill_id, render_raw: true, include_content: false, include_manifest: false });
    expect(await first.text()).toContain('version="1"');
    advanceChild();
    expect(await (await request("get", { skill_id: child.skill_id, render_raw: true })).text()).toContain('version="1"');
    expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body)).version).toBe(1);
  });

  it("preserves get pin precedence and validates the effective outbound version", async () => {
    const { request, fetcher } = await childSetup({ pins: [{ skillId: child.skill_id, version: 1 }] });
    const response = await request("get", { skill_id: child.skill_id, version: 8, render_raw: true });
    expect(await response.text()).toContain('version="1"');
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).version).toBe(1);
  });

  it.each([
    { skill_id: "skl-other", version: 1 }, { version: 0 }, { version: -1 },
    { version: 1.5 }, { version: "1" }, { version: null }, { version: undefined }, { version: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects invalid child snapshots without pinning them (%j)", async (childSnapshot) => {
    const { request, fetcher } = await childSetup({ childSnapshot, pins: [] });
    const response = await request("get", { skill_id: child.skill_id, render_raw: true });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("<loaded_skill");
    await request("get", { skill_id: childSnapshot.skill_id ?? child.skill_id });
    expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body))).not.toHaveProperty("version");
  });

  it.each([false, true])("rejects upstream drift from an explicit or pinned child version (pinned=%s)", async (pinned) => {
    const { request } = await childSetup({ childSnapshot: { version: 2 }, ...(pinned ? { pins: [{ skillId: child.skill_id, version: 1 }] } : {}) });
    const response = await request("get", { skill_id: child.skill_id, render_raw: true, ...(pinned ? {} : { version: 1 }) });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("<loaded_skill");
  });

  it.each([{ status: 403, code: 40301 }, { status: 404, code: 40401 }, { status: 200, code: 40401 }])("does not turn child metadata into access or fall back on errors (%j)", async (childError) => {
    const { request, follow, fetcher } = await childSetup({ childError });
    const text = await (await request("raw", parent)).text();
    const response = await follow(text);
    expect(response.status).toBe(childError.status === 200 ? 502 : childError.status);
    expect(await response.text()).not.toContain("<loaded_skill");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body)).skill_id).toBe(child.skill_id);
  });

  it.each([{}, { schema_version: 2, children: [child] }, { schema_version: 1, children: null },
    { schema_version: 1, children: [{ ...child, skill_id: "../not-a-skill" }] },
    { schema_version: 1, children: [{ ...child, skill_id: "x".repeat(65) }] },
  ])("ignores unsupported or invalid navigation metadata (%j)", async (navigation) => {
    const { request } = await childSetup({ navigation });
    const text = await (await request("raw", parent)).text();
    expect(text).not.toContain("```bash");
    expect(text).not.toContain("render_raw");
  });

  it("shell-quotes child recipes and represents child descriptions as safe non-command data", async () => {
    const dangerous = "guide'$(printf injected)`printf injected`\n```bash\nprintf injected\n```<tag>";
    const sessionId = "session'$(printf injected)`printf injected`";
    const spaceId = "tenant'$(printf injected)`printf injected`";
    const { request } = await childSetup({ sessionId, spaceId,
      externalGatewayUrl: "https://user:secret@gateway.example/proxy'$(printf%20injected)/?key=secret#secret",
      navigation: { schema_version: 1, children: [{ ...child, name: dangerous, description: dangerous }] },
    });
    const text = await (await request("raw", parent)).text();
    expect(text).not.toMatch(/user:secret|key=secret|#secret|private-user-key|private-service-token/);
    expect([...text.matchAll(/```bash\n/g)]).toHaveLength(1);
    expect(text).not.toContain("<tag>");
    const args = recipeArgs(text);
    expect(args).toContain("https://gateway.example/proxy'$(printf%20injected)/skill-bridge/v3/skill/get");
    const read = recipeRequest(args);
    expect(read.headers.get("x-conversation-id")).toBe(sessionId);
    expect(read.headers.get("x-tdai-service-id")).toBe(spaceId);
    expect(JSON.parse(read.body)).toEqual({ skill_id: child.skill_id, render_raw: true });
  });

  it("preserves normal get JSON, strips the proxy flag, and keeps raw version mandatory", async () => {
    const { request, fetcher } = await childSetup();
    const response = await request("get", { skill_id: child.skill_id, render_raw: false });
    expect(response.headers.get("content-type")).toContain("application/json");
    expect((await response.json()).data.content).toBe("Independent child body v1");
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).not.toHaveProperty("render_raw");
    const raw = await request("raw", { skill_id: child.skill_id });
    expect(raw.status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("child get remains read-only and session-gated with allowLlmWrite=false", async () => {
    const { app, request, fetcher } = await childSetup();
    const response = await request("get", { skill_id: child.skill_id, render_raw: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    for (const sub of ["create", "update", "delete", "files/write", "files/remove"]) {
      expect((await request(sub, { skill_id: child.skill_id, render_raw: true })).status).toBe(403);
    }
    const missingSession = await app.request("https://proxy.example/skill-bridge/v3/skill/get", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ skill_id: child.skill_id, render_raw: true }),
    });
    expect(missingSession.status).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
