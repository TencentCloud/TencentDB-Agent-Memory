/**
 * Regression tests for bridge-layer secondary auth (user_key verification).
 *
 * Background: the bridges (/memory-bridge/*, /skill-bridge/*) used to trust
 * "session identity" only (x-conversation-id → session binding → IdFields)
 * and validated no credentials. Conv-ids are semi-public — they appear in
 * plaintext in client configs, skill docs, injection logs, and the system
 * prompt injected by the proxy. On a public deployment, a leaked conv-id
 * alone is enough to read the full L0/L1/L2 memory and skill content.
 *
 * Fix: verify the user_key stored in the session binding (a server-trusted
 * value exchanged from the upstream api key during session-init) against
 * the core auth endpoint.
 *
 * This suite covers four branches:
 *   1. auth disabled → skip (single-instance / local dev, behavior unchanged)
 *   2. missing user_key → 500 (programming error, never fail open)
 *   3. verify fails → 401 (same semantics as the model path's verifyUserKey)
 *   4. verify passes → allowed (null)
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { initAuth } from "../../auth.js";
import { verifySessionUserKey } from "../../memory/memory-bridge.js";
import { verifySessionUserKey as verifySkillSessionUserKey } from "../../skill/skill-bridge.js";

/** Spins up a fake auth server that answers valid / invalid per user_key. */
async function startFakeAuth(validKeys: Set<string>): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let key = "";
      try {
        key = (JSON.parse(body) as { user_key?: string }).user_key ?? "";
      } catch {
        key = "";
      }
      const valid = validKeys.has(key);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          code: 0,
          data: { valid, user: { user_id: valid ? "usr-test" : "" } },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const IDS = {
  user_id: "usr-test",
  team_id: "team-test",
  agent_id: "agt-test",
  session_id: "sess-test",
} as Parameters<typeof verifySessionUserKey>[0];

/** skill-bridge's SessionIdFields requires agent_source (three-segment isolation key); built separately. */
const SKILL_IDS = {
  user_id: "usr-test",
  team_id: "team-test",
  agent_id: "agt-test",
  session_id: "sess-test",
  agent_source: "test",
} as Parameters<typeof verifySkillSessionUserKey>[0];

describe("bridge user_key verification", () => {
  afterEach(() => {
    // auth disabled = empty config (initAuth({enabled:false}))
    initAuth({ enabled: false, url: "", timeoutMs: 1000 });
  });

  it("skips verification when auth is disabled (single-instance / local dev)", async () => {
    initAuth({ enabled: false, url: "", timeoutMs: 1000 });
    const res = await verifySessionUserKey(IDS, "default", "sess-test");
    expect(res).toBeNull();
  });

  it("returns 401 when the session's user_key is rejected", async () => {
    const fake = await startFakeAuth(new Set(["good-key"]));
    try {
      initAuth({ enabled: true, url: fake.url, timeoutMs: 2000 });
      const res = await verifySessionUserKey(
        { ...IDS, user_key: "bad-key" },
        "default",
        "sess-test",
      );
      expect(res).not.toBeNull();
      expect(res!.status).toBe(401);
      const body = (await res!.json()) as { code: number; message: string };
      expect(body.code).toBe(40101);
      expect(body.message).toContain("rejected");
    } finally {
      await fake.close();
    }
  });

  it("returns 500 (not a silent pass) when the session has no user_key", async () => {
    const fake = await startFakeAuth(new Set(["good-key"]));
    try {
      initAuth({ enabled: true, url: fake.url, timeoutMs: 2000 });
      const res = await verifySessionUserKey(IDS, "default", "sess-test");
      expect(res).not.toBeNull();
      expect(res!.status).toBe(500);
      const body = (await res!.json()) as { code: number };
      expect(body.code).toBe(50001);
    } finally {
      await fake.close();
    }
  });

  it("passes when the session's user_key verifies", async () => {
    const fake = await startFakeAuth(new Set(["good-key"]));
    try {
      initAuth({ enabled: true, url: fake.url, timeoutMs: 2000 });
      const res = await verifySessionUserKey(
        { ...IDS, user_key: "good-key" },
        "default",
        "sess-test",
      );
      expect(res).toBeNull();
    } finally {
      await fake.close();
    }
  });
});

describe("skill-bridge user_key verification (mirrored logic)", () => {
  afterEach(() => {
    initAuth({ enabled: false, url: "", timeoutMs: 1000 });
  });

  it("returns 401 when the session's user_key is rejected", async () => {
    const fake = await startFakeAuth(new Set(["good-key"]));
    try {
      initAuth({ enabled: true, url: fake.url, timeoutMs: 2000 });
      const res = await verifySkillSessionUserKey(
        { ...SKILL_IDS, user_key: "bad-key" },
        "default",
        "sess-test",
      );
      expect(res).not.toBeNull();
      expect(res!.status).toBe(401);
      const body = (await res!.json()) as { code: number; message: string };
      expect(body.code).toBe(40101);
      expect(body.message).toContain("rejected");
    } finally {
      await fake.close();
    }
  });

  it("returns 500 (not a silent pass) when the session has no user_key", async () => {
    const fake = await startFakeAuth(new Set(["good-key"]));
    try {
      initAuth({ enabled: true, url: fake.url, timeoutMs: 2000 });
      const res = await verifySkillSessionUserKey(SKILL_IDS, "default", "sess-test");
      expect(res).not.toBeNull();
      expect(res!.status).toBe(500);
      const body = (await res!.json()) as { code: number };
      expect(body.code).toBe(50001);
    } finally {
      await fake.close();
    }
  });

  it("passes when the session's user_key verifies", async () => {
    const fake = await startFakeAuth(new Set(["good-key"]));
    try {
      initAuth({ enabled: true, url: fake.url, timeoutMs: 2000 });
      const res = await verifySkillSessionUserKey(
        { ...SKILL_IDS, user_key: "good-key" },
        "default",
        "sess-test",
      );
      expect(res).toBeNull();
    } finally {
      await fake.close();
    }
  });
});
