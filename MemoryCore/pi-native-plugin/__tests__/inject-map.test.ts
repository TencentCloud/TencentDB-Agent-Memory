import { test, expect } from "vitest";

// TDAI_INJECT_MAP is read once at module load, so this file configures the
// environment and then imports its own module instance (the `?inject-map`
// query keeps it separate from the instance index.test.ts loads without a map).
process.env.TDAI_GATEWAY_URL = "http://tdai.test";
process.env.TDAI_KNOWLEDGE_URL = "http://tdai-knowledge.test";
process.env.TDAI_API_KEY = "fake-key";
process.env.TDAI_SERVICE_ID = "default";
process.env.TDAI_TEAM_ID = "team-test";
process.env.TDAI_USER_ID = "usr-test";
process.env.TDAI_AGENT_ID = "agt-test";
process.env.TDAI_INJECT = "1";
process.env.TDAI_CAPTURE = "1";
process.env.TDAI_INJECT_MAP = "wiki-test:wiki/index/knowledge-map.md";

const MAP_PAGE =
  "---\ntype: orientation\nlocked: true\n---\n# Knowledge Map\n\nQuery the wiki BEFORE any filesystem discovery.";

const calls: { url: string; body: Record<string, unknown> }[] = [];
let knowledgeDown = false;
const json = (status: number, obj: unknown) => new Response(JSON.stringify(obj), { status });
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  calls.push({ url: String(url), body });
  const u = String(url);
  if (u.endsWith("/v3/wiki/page/read")) {
    if (knowledgeDown) return json(503, { code: 1, message: "knowledge unavailable" });
    return json(200, { code: 0, data: { items: [{ ref: "wiki/index/knowledge-map.md", content: MAP_PAGE }] } });
  }
  if (u.endsWith("/v3/core/read")) return json(200, { code: 0, data: { content: "TEST CORE PERSONA" } });
  if (u.endsWith("/v3/scenario/ls")) return json(200, { code: 0, data: { entries: [], total: 0 } });
  if (u.endsWith("/v3/atomic/search")) return json(200, { code: 0, data: { results: [] } });
  return json(404, { code: 1, message: "not found" });
}) as typeof fetch;

const { default: extension } = await import("../extensions/tdai-memory/index.js?inject-map");

type Handler = (...a: unknown[]) => unknown;
type InjectResult = { message?: { customType: string; content: string; display: boolean } } | undefined;

function makePi() {
  const handlers: Record<string, Handler[]> = {};
  const pi = {
    on: (name: string, fn: Handler) => {
      (handlers[name] ||= []).push(fn);
    },
    registerTool: () => {},
    appendEntry: () => {},
  };
  return { pi, handlers };
}

const uiCtx = { ui: { setStatus: () => {}, theme: { fg: (_: string, s: string) => s } } };
function freshSession(handlers: Record<string, Handler[]>) {
  for (const h of handlers.session_start ?? []) h({}, uiCtx);
}
const turn = (handlers: Record<string, Handler[]>) =>
  handlers.before_agent_start[0]({ systemPrompt: "P", systemPromptOptions: { cwd: "/x" } }, {}) as Promise<InjectResult>;
const mapReads = () => calls.filter((c) => c.url.endsWith("/v3/wiki/page/read"));

test("first turn injects the knowledge-map page named by TDAI_INJECT_MAP, frontmatter stripped", async () => {
  calls.length = 0;
  const { pi, handlers } = makePi();
  extension(pi);
  freshSession(handlers);

  const res = await turn(handlers);

  expect(res?.message?.display).toBe(true);
  expect(res?.message?.customType).toBe("tdai-memory-inject");
  expect(res?.message?.content).toContain("<tdai-knowledge-map>");
  expect(res?.message?.content).toContain("Query the wiki BEFORE any filesystem discovery.");
  expect(res?.message?.content).not.toContain("locked: true");
  // The map is read from the wiki and page named in the env var, with tenant identity.
  expect(mapReads()).toHaveLength(1);
  expect(mapReads()[0].body).toMatchObject({
    wiki_id: "wiki-test",
    refs: ["wiki/index/knowledge-map.md"],
    team_id: "team-test",
  });
  // The map block comes before the persona block: orientation first.
  const content = res?.message?.content ?? "";
  expect(content.indexOf("<tdai-knowledge-map>")).toBeLessThan(content.indexOf("TEST CORE PERSONA"));
});

test("the map is pushed once per session and again after session_compact", async () => {
  calls.length = 0;
  const { pi, handlers } = makePi();
  extension(pi);
  freshSession(handlers);

  await turn(handlers);
  const second = await turn(handlers);
  expect(second?.message?.content ?? "").not.toContain("<tdai-knowledge-map>");
  expect(mapReads()).toHaveLength(1);

  handlers.session_compact[0]({}, {});
  const third = await turn(handlers);
  expect(third?.message?.content).toContain("<tdai-knowledge-map>");
  expect(mapReads()).toHaveLength(2);
});

test("a knowledge-service outage on the first turn does not latch: the next turn retries the map", async () => {
  calls.length = 0;
  const { pi, handlers } = makePi();
  extension(pi);
  freshSession(handlers);

  knowledgeDown = true;
  try {
    const first = await turn(handlers);
    // Persona still lands (fail-open per block); the map does not.
    expect(first?.message?.content).toContain("TEST CORE PERSONA");
    expect(first?.message?.content ?? "").not.toContain("<tdai-knowledge-map>");
  } finally {
    knowledgeDown = false;
  }

  const second = await turn(handlers);
  expect(second?.message?.content).toContain("<tdai-knowledge-map>");
  expect(mapReads()).toHaveLength(2);
});

test("an unparseable TDAI_INJECT_MAP (no wiki_id:ref separator) never calls the knowledge service", async () => {
  process.env.TDAI_INJECT_MAP = "no-separator-here";
  const { default: badMapExtension } = await import("../extensions/tdai-memory/index.js?inject-map-bad");
  process.env.TDAI_INJECT_MAP = "wiki-test:wiki/index/knowledge-map.md";

  calls.length = 0;
  const { pi, handlers } = makePi();
  badMapExtension(pi);
  freshSession(handlers);

  const res = await turn(handlers);
  expect(res?.message?.content).toContain("TEST CORE PERSONA");
  expect(res?.message?.content ?? "").not.toContain("<tdai-knowledge-map>");
  expect(mapReads()).toHaveLength(0);
});
