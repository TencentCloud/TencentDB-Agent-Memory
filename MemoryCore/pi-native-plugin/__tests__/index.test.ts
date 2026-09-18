import { test, expect } from "vitest";

// Configure the extension BEFORE importing it (it reads config at module load).
process.env.TDAI_GATEWAY_URL = "http://tdai.test";
// Trailing slash on purpose: exercises base-URL trailing-slash normalization (#7).
process.env.TDAI_KNOWLEDGE_URL = "http://tdai-knowledge.test/";
process.env.TDAI_API_KEY = "fake-key";
process.env.TDAI_SERVICE_ID = "default";
process.env.TDAI_TEAM_ID = "team-test";
process.env.TDAI_USER_ID = "usr-test";
process.env.TDAI_AGENT_ID = "agt-test";
process.env.TDAI_INJECT = "1";
process.env.TDAI_CAPTURE = "1";

// Mock fetch — route by URL suffix, capture request bodies.
const calls: { url: string; body: Record<string, unknown> }[] = [];
const json = (status: number, obj: unknown) =>
  new Response(JSON.stringify(obj), { status });
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const body = init?.body
    ? (JSON.parse(String(init.body)) as Record<string, unknown>)
    : {};
  calls.push({ url: String(url), body });
  const u = String(url);
  if (u.endsWith("/v3/core/read"))
    return json(200, { code: 0, data: { content: "TEST CORE PERSONA" } });
  if (u.endsWith("/v3/scenario/ls"))
    return json(200, {
      code: 0,
      data: {
        entries: [{ path: "proj.md", summary: "proj summary" }],
        total: 1,
      },
    });
  if (u.endsWith("/v3/conversation/add"))
    return json(200, { code: 0, data: { ok: true } });
  return json(404, { code: 1, message: "not found" });
}) as typeof fetch;

const { default: extension } = await import(
  "../extensions/tdai-memory/index.js"
);

type ToolDef = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

function makePi() {
  const handlers: Record<string, Array<(...a: unknown[]) => unknown>> = {};
  const tools = new Map<string, ToolDef>();
  const appended: Array<{ type: string; data?: unknown }> = [];
  const pi = {
    on: (name: string, fn: (...a: unknown[]) => unknown) => {
      (handlers[name] ||= []).push(fn);
    },
    registerTool: (def: ToolDef) => {
      tools.set(def.name, def);
    },
    appendEntry: (type: string, data?: unknown) => {
      appended.push({ type, data });
    },
  };
  return { pi, handlers, appended, tools };
}

// Swap in a fetch mock that records requests; returns restore() to undo.
function mockFetch(status: number, body: unknown) {
  const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
  const prev = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return new Response(
      typeof body === "string" ? body : JSON.stringify(body),
      { status },
    );
  }) as typeof fetch;
  return { seen, restore: () => (globalThis.fetch = prev) };
}

// ── tool-level guards (issues #2, #3, #5, #6, #7, #8, #9, #11, #12, #15) ───

function getTool(name: string): ToolDef {
  const { pi, tools } = makePi();
  extension(pi);
  const tool = tools.get(name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
}

test("#2 tdai_wiki_write rejects more than 20 pages", async () => {
  const pages = Array.from({ length: 21 }, (_, i) => ({
    ref: `p${i}.md`,
    content: "x",
  }));
  await expect(
    getTool("tdai_wiki_write").execute("1", { wiki_id: "w", pages }),
  ).rejects.toThrow(/21 pages given, max is 20/);
});

test("#3 tdai_wiki_read rejects more than 20 refs", async () => {
  const refs = Array.from({ length: 21 }, (_, i) => `p${i}.md`);
  await expect(
    getTool("tdai_wiki_read").execute("1", { wiki_id: "w", refs }),
  ).rejects.toThrow(/21 refs given, max is 20/);
});

test("#5 non-JSON 200 body -> friendly tdai error, not a raw SyntaxError", async () => {
  const { restore } = mockFetch(200, "<html>bad gateway</html>");
  try {
    await expect(
      getTool("tdai_search").execute("1", { query: "q" }),
    ).rejects.toThrow(/^tdai \/v3\/atomic\/search: response is not valid JSON/);
  } finally {
    restore();
  }
});

test("#5 literal null body does not throw a TypeError", async () => {
  const { restore } = mockFetch(200, "null");
  try {
    const res = await getTool("tdai_search").execute("1", { query: "q" });
    expect(res.content[0].text).toBe("{}");
  } finally {
    restore();
  }
});

test("#6 explicit data:null returns the null payload, not the envelope", async () => {
  const { restore } = mockFetch(200, {
    code: 0,
    message: "ok",
    request_id: "req-1",
    data: null,
  });
  try {
    const res = await getTool("tdai_search").execute("1", { query: "q" });
    expect(res.content[0].text).toBe("null");
    expect(res.content[0].text).not.toContain("request_id");
  } finally {
    restore();
  }
});

test("#6 missing data key still falls back to the envelope", async () => {
  const { restore } = mockFetch(200, { code: 0, message: "ok" });
  try {
    const res = await getTool("tdai_search").execute("1", { query: "q" });
    expect(res.content[0].text).toContain("message");
  } finally {
    restore();
  }
});

test("#7 trailing-slash base URL does not produce a double slash", async () => {
  const { seen, restore } = mockFetch(200, { code: 0, data: [] });
  try {
    await getTool("tdai_wiki_list").execute("1", {});
    expect(seen[0].url).toBe("http://tdai-knowledge.test/v3/wiki/list");
  } finally {
    restore();
  }
});

test("#8 tdai_wiki_pages sends a limit (default 20, clamped max 100)", async () => {
  const { seen, restore } = mockFetch(200, { code: 0, data: [] });
  try {
    await getTool("tdai_wiki_pages").execute("1", { wiki_id: "w" });
    expect(seen[0].body.limit).toBe(20);
    await getTool("tdai_wiki_pages").execute("1", { wiki_id: "w", limit: 5 });
    expect(seen[1].body.limit).toBe(5);
    await getTool("tdai_wiki_pages").execute("1", { wiki_id: "w", limit: 999 });
    expect(seen[2].body.limit).toBe(100);
  } finally {
    restore();
  }
});

test("#9 limit/offset are clamped to documented bounds", async () => {
  const { seen, restore } = mockFetch(200, { code: 0, data: [] });
  try {
    await getTool("tdai_search").execute("1", { query: "q", limit: 5000 });
    expect(seen[0].body.limit).toBe(100);
    await getTool("tdai_search").execute("1", { query: "q", limit: -5 });
    expect(seen[1].body.limit).toBe(1);
    await getTool("tdai_search").execute("1", { query: "q", limit: 2.5 });
    expect(seen[2].body.limit).toBe(2);
    await getTool("tdai_memory_list").execute("1", { offset: -3 });
    expect(seen[3].body.offset).toBe(0);
  } finally {
    restore();
  }
});

test("#11 timeout gets a distinct retry hint, not the reachability message", async () => {
  const prev = globalThis.fetch;
  globalThis.fetch = (async () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    throw err;
  }) as typeof fetch;
  try {
    await expect(
      getTool("tdai_search").execute("1", { query: "q" }),
    ).rejects.toThrow(/timed out after 60s.*retry/s);
  } finally {
    globalThis.fetch = prev;
  }
});

test("#11 plain network errors still get the reachability message", async () => {
  const prev = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  try {
    await expect(
      getTool("tdai_search").execute("1", { query: "q" }),
    ).rejects.toThrow(/is the memory gateway reachable\?/);
  } finally {
    globalThis.fetch = prev;
  }
});

test("#12 tdai_capture: empty-string session falls back to local-date default", async () => {
  const { seen, restore } = mockFetch(200, { code: 0, data: { ok: true } });
  try {
    await getTool("tdai_capture").execute("1", { text: "note", session: "" });
    expect(seen[0].body.session_id).toMatch(/^pi-\d{4}-\d{2}-\d{2}$/);
    await getTool("tdai_capture").execute("1", {
      text: "note",
      session: "my-sess",
    });
    expect(seen[1].body.session_id).toBe("my-sess");
  } finally {
    restore();
  }
});

test("#15 lock-conflict responses get an actionable retry hint", async () => {
  const { restore } = mockFetch(409, {
    code: 40901,
    message: "page is locked by another writer",
  });
  try {
    await expect(
      getTool("tdai_wiki_write").execute("1", {
        wiki_id: "w",
        pages: [{ ref: "a.md", content: "x" }],
      }),
    ).rejects.toThrow(/locked by another writer.*retry/s);
  } finally {
    restore();
  }
});

test("#15 non-lock errors are unchanged", async () => {
  const { restore } = mockFetch(500, { code: 50000, message: "internal boom" });
  try {
    await expect(
      getTool("tdai_wiki_write").execute("1", {
        wiki_id: "w",
        pages: [{ ref: "a.md", content: "x" }],
      }),
    ).rejects.toThrow(
      /^tdai \/v3\/wiki\/page\/write HTTP 500: \{"code":50000,"message":"internal boom"\}$/,
    );
  } finally {
    restore();
  }
});

// ── before_agent_start: visible injection, once-per-session L2/L3 + per-turn L1 ──
// Module state (sessionOpened, lastAtomicFingerprint) persists across tests in this
// file — every test below starts by firing session_start to get a clean slate,
// exactly the reset a real /new or /resume would trigger.
function freshSession(handlers: ReturnType<typeof makePi>["handlers"]) {
  handlers.session_start[0]({}, {
    ui: { setStatus: () => {}, theme: { fg: (_: string, s: string) => s } },
  });
}

test("first turn of a session injects core + scenario as a VISIBLE message, not the system prompt", async () => {
  const { pi, handlers } = makePi();
  extension(pi);
  freshSession(handlers);
  const h = handlers.before_agent_start[0];
  const res = (await h(
    { systemPrompt: "BASE PROMPT", systemPromptOptions: { cwd: "/test/cwd" } },
    {},
  )) as { systemPrompt?: string; message?: { customType: string; content: string; display: boolean } };
  expect(res.systemPrompt).toBeUndefined();
  expect(res.message?.display).toBe(true);
  expect(res.message?.customType).toBe("tdai-memory-inject");
  expect(res.message?.content).toContain("TEST CORE PERSONA");
  expect(res.message?.content).toContain("proj.md");
  expect(res.message?.content).toContain("proj summary");
});

test("the SECOND turn of the same session does not repeat the full L2/L3 push", async () => {
  const { pi, handlers } = makePi();
  extension(pi);
  freshSession(handlers);
  const h = handlers.before_agent_start[0];
  await h({ systemPrompt: "P", systemPromptOptions: { cwd: "/x" } }, {}); // first turn
  const res = (await h(
    { systemPrompt: "P", systemPromptOptions: { cwd: "/x" }, prompt: "" },
    {},
  )) as { message?: { content: string } };
  // second turn: no query text either, so nothing at all to inject
  expect(res).toBeUndefined();
});

test("a NEW session (session_start again) gets the full push again", async () => {
  const { pi, handlers } = makePi();
  extension(pi);
  freshSession(handlers);
  const h = handlers.before_agent_start[0];
  await h({ systemPrompt: "P", systemPromptOptions: { cwd: "/x" } }, {}); // first session's first turn
  freshSession(handlers); // /new or /resume
  const res = (await h(
    { systemPrompt: "P", systemPromptOptions: { cwd: "/x" } },
    {},
  )) as { message?: { content: string } };
  expect(res.message?.content).toContain("TEST CORE PERSONA");
});

test("every turn searches L1 atoms with THIS turn's own incoming prompt text", async () => {
  const { pi, handlers } = makePi();
  extension(pi);
  freshSession(handlers);
  const { seen, restore } = mockFetch(200, {
    code: 0,
    data: { results: [{ content: "vouchers ship in farm2" }] },
  });
  try {
    const h = handlers.before_agent_start[0];
    const res = (await h(
      { systemPrompt: "P", systemPromptOptions: { cwd: "/x" }, prompt: "what about vouchers?" },
      {},
    )) as { message?: { content: string } };
    // this is the FIRST turn of a fresh session, so core/scenario calls fire first —
    // find the atomic search call by URL rather than assume its index.
    const atomicCall = seen.find((c) => c.url.endsWith("/v3/atomic/search"));
    expect(atomicCall?.body.query).toBe("what about vouchers?");
    expect(atomicCall?.body.limit).toBe(3);
    expect(res.message?.content).toContain("vouchers ship in farm2");
  } finally {
    restore();
  }
});

test("identical atomic hits across consecutive turns are not repeated", async () => {
  const { pi, handlers } = makePi();
  extension(pi);
  freshSession(handlers);
  const { restore } = mockFetch(200, {
    code: 0,
    data: { results: [{ content: "same fact every time" }] },
  });
  try {
    const h = handlers.before_agent_start[0];
    const first = (await h(
      { systemPrompt: "P", systemPromptOptions: { cwd: "/x" }, prompt: "q1" },
      {},
    )) as { message?: { content: string } };
    expect(first.message?.content).toContain("same fact every time");

    const second = (await h(
      { systemPrompt: "P", systemPromptOptions: { cwd: "/x" }, prompt: "q2" },
      {},
    )) as { message?: { content: string } | undefined } | undefined;
    // full L2/L3 already sent on turn one, and the atoms are identical -> nothing left to send
    expect(second).toBeUndefined();
  } finally {
    restore();
  }
});

test("changed atomic hits are NOT suppressed on the next turn", async () => {
  const { pi, handlers } = makePi();
  extension(pi);
  freshSession(handlers);
  const h = handlers.before_agent_start[0];

  // try/finally throughout — found by review: a bare `m.restore()` call after the
  // assertion left the mock leaked into every LATER test in the file if that
  // assertion ever threw, since bun does not isolate globalThis.fetch per test.
  let m = mockFetch(200, { code: 0, data: { results: [{ content: "fact one" }] } });
  try {
    const first = (await h(
      { systemPrompt: "P", systemPromptOptions: { cwd: "/x" }, prompt: "q1" },
      {},
    )) as { message?: { content: string } };
    expect(first.message?.content).toContain("fact one");
  } finally {
    m.restore();
  }

  m = mockFetch(200, { code: 0, data: { results: [{ content: "fact two" }] } });
  try {
    const second = (await h(
      { systemPrompt: "P", systemPromptOptions: { cwd: "/x" }, prompt: "q2" },
      {},
    )) as { message?: { content: string } };
    expect(second.message?.content).toContain("fact two");
  } finally {
    m.restore();
  }
});

test("an atomic-search outage is a VISIBLE marker, not silently swallowed", async () => {
  const { pi, handlers } = makePi();
  extension(pi);
  freshSession(handlers);
  const prev = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  try {
    const h = handlers.before_agent_start[0];
    const res = (await h(
      { systemPrompt: "P", systemPromptOptions: { cwd: "/x" }, prompt: "anything" },
      {},
    )) as { message?: { content: string } };
    expect(res.message?.content).toContain("tdai-memory-unavailable");
    expect(res.message?.content).toContain("reachable");
  } finally {
    globalThis.fetch = prev;
  }
});

test("a repeated outage marks EVERY turn it actually fails, never deduped against itself", async () => {
  const { pi, handlers } = makePi();
  extension(pi);
  freshSession(handlers);
  const prev = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  try {
    const h = handlers.before_agent_start[0];
    const first = (await h(
      { systemPrompt: "P", systemPromptOptions: { cwd: "/x" }, prompt: "q1" },
      {},
    )) as { message?: { content: string } };
    const second = (await h(
      { systemPrompt: "P", systemPromptOptions: { cwd: "/x" }, prompt: "q2" },
      {},
    )) as { message?: { content: string } };
    expect(first.message?.content).toContain("tdai-memory-unavailable");
    expect(second.message?.content).toContain("tdai-memory-unavailable");
  } finally {
    globalThis.fetch = prev;
  }
});

test("no hits and no query text -> no message at all, not an empty one", async () => {
  const { pi, handlers } = makePi();
  extension(pi);
  freshSession(handlers);
  const prev = globalThis.fetch;
  // Everything empty: no core, no scenarios, no atoms — this is still the FIRST
  // turn of the session (freshSession reset sessionOpened), so the full push is
  // attempted; it must yield nothing rather than an empty <tdai-memory></tdai-memory>.
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    if (u.endsWith("/v3/core/read")) return new Response(JSON.stringify({ code: 0, data: { content: null } }), { status: 200 });
    if (u.endsWith("/v3/scenario/ls")) return new Response(JSON.stringify({ code: 0, data: { entries: [] } }), { status: 200 });
    if (u.endsWith("/v3/atomic/search")) return new Response(JSON.stringify({ code: 0, data: { results: [] } }), { status: 200 });
    return new Response(JSON.stringify({ code: 1, message: "not found" }), { status: 404 });
  }) as typeof fetch;
  try {
    const h = handlers.before_agent_start[0];
    const res = await h(
      { systemPrompt: "P", systemPromptOptions: { cwd: "/x" }, prompt: "q" },
      {},
    );
    expect(res).toBeUndefined();
  } finally {
    globalThis.fetch = prev;
  }
});

test("a first-turn outage does NOT permanently lose the full push — the next turn retries and succeeds", async () => {
  // Found by review: buildMemoryBlock is internally fail-open (its own core/
  // scenario try/catches never rethrow), so the OLD code latched sessionOpened
  // BEFORE the fetch — a single transient hiccup at the exact moment of the
  // session's first prompt meant no persona for the session's entire life,
  // silently. The fix only latches when at least one call actually reached tdai.
  const { pi, handlers } = makePi();
  extension(pi);
  freshSession(handlers);
  const h = handlers.before_agent_start[0];
  const prev = globalThis.fetch;
  try {
    // Turn 1: total outage — both core/read and scenario/ls throw.
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const first = await h(
      { systemPrompt: "P", systemPromptOptions: { cwd: "/x" } }, // no prompt -> no atomic call
      {},
    );
    expect(first).toBeUndefined(); // both calls failed silently, nothing to inject yet

    // Turn 2: tdai recovers — this must be treated as STILL the first successful turn.
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.endsWith("/v3/core/read"))
        return new Response(JSON.stringify({ code: 0, data: { content: "RECOVERED PERSONA" } }), { status: 200 });
      if (u.endsWith("/v3/scenario/ls"))
        return new Response(JSON.stringify({ code: 0, data: { entries: [] } }), { status: 200 });
      return new Response(JSON.stringify({ code: 1, message: "not found" }), { status: 404 });
    }) as typeof fetch;
    const second = (await h(
      { systemPrompt: "P", systemPromptOptions: { cwd: "/x" } },
      {},
    )) as { message?: { content: string } };
    expect(second.message?.content).toContain("RECOVERED PERSONA");
  } finally {
    globalThis.fetch = prev;
  }
});

test("session_compact re-arms the full push so persona survives compaction", async () => {
  const { pi, handlers } = makePi();
  extension(pi);
  freshSession(handlers);
  const h = handlers.before_agent_start[0];
  await h({ systemPrompt: "P", systemPromptOptions: { cwd: "/x" } }, {}); // consumes the first-turn push

  const second = (await h({ systemPrompt: "P", systemPromptOptions: { cwd: "/x" } }, {})) as
    | { message?: { content: string } }
    | undefined;
  expect(second).toBeUndefined(); // second turn, same session: no repeat, as designed

  handlers.session_compact[0]({}, {}); // the framework summarized the injected message away
  const third = (await h(
    { systemPrompt: "P", systemPromptOptions: { cwd: "/x" } },
    {},
  )) as { message?: { content: string } };
  expect(third.message?.content).toContain("TEST CORE PERSONA");
});

test("the per-turn query sent to atomic search is capped, not the raw prompt verbatim", async () => {
  const { pi, handlers } = makePi();
  extension(pi);
  freshSession(handlers);
  const { seen, restore } = mockFetch(200, { code: 0, data: { results: [] } });
  try {
    const h = handlers.before_agent_start[0];
    const hugePrompt = "q".repeat(200_000);
    await h(
      { systemPrompt: "P", systemPromptOptions: { cwd: "/x" }, prompt: hugePrompt },
      {},
    );
    const atomicCall = seen.find((c) => c.url.endsWith("/v3/atomic/search"));
    const sentQuery = atomicCall?.body.query as string;
    expect(sentQuery.length).toBeLessThan(hugePrompt.length);
    expect(sentQuery.length).toBeLessThanOrEqual(2000);
  } finally {
    restore();
  }
});

test("session_shutdown captures the session (normalized) and records the marker", async () => {
  const { pi, handlers, appended } = makePi();
  extension(pi);
  const entries = [
    {
      type: "message",
      id: "e1",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    },
    {
      type: "message",
      id: "e2",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "hi there" },
          { type: "thinking", thinking: "secret" },
        ],
      },
    },
  ];
  const ctx = {
    sessionManager: { getEntries: () => entries, getSessionId: () => "sess-1" },
  };
  await handlers.session_shutdown[0]({}, ctx);

  const add = calls.find((c) => c.url.endsWith("/v3/conversation/add"));
  expect(add).toBeTruthy();
  expect(add.body.messages).toEqual([
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
  ]);
  expect(add.body.session_id).toBe("sess-1");
  expect(appended[0].type).toBe("tdai-capture");
  expect((appended[0].data as { lastEntryId: string }).lastEntryId).toBe("e2");
});

test("session_shutdown is a no-op when nothing new since the last capture", async () => {
  const { pi, handlers } = makePi();
  extension(pi);
  const before = calls.filter((c) =>
    c.url.endsWith("/v3/conversation/add"),
  ).length;
  const entries = [
    {
      type: "custom",
      id: "m1",
      customType: "tdai-capture",
      data: { lastEntryId: "e2" },
    },
    {
      type: "message",
      id: "e1",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    },
    {
      type: "message",
      id: "e2",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    },
  ];
  const ctx = {
    sessionManager: { getEntries: () => entries, getSessionId: () => "sess-1" },
  };
  await handlers.session_shutdown[0]({}, ctx);
  const after = calls.filter((c) =>
    c.url.endsWith("/v3/conversation/add"),
  ).length;
  expect(after).toBe(before); // dedupe: no re-send
});
