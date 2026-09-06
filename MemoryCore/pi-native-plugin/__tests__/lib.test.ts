import { test, expect } from "vitest";
import {
  chunkContent,
  splitBatches,
  selectScenarioPaths,
  assembleMemoryBlock,
  normalizeEntries,
  missingRequiredEnv,
  isKillSwitchOff,
  atomicHitsFrom,
  atomicFingerprint,
  sameFingerprint,
  REQUIRED_ENV,
  MAX_MSG_CHARS,
  MAX_MSGS_PER_POST,
  ATOMIC_SUMMARY_MAX,
  type L0Message,
  type SessionEntryLike,
} from "../extensions/tdai-memory/lib.js";

// ── chunkContent ─────────────────────────────────────────────────────────────
test("chunkContent: short string -> single unchanged chunk", () => {
  expect(chunkContent("hello")).toEqual(["hello"]);
});

test("chunkContent: each chunk within max, order + no data loss", () => {
  const s = "a".repeat(25) + "b".repeat(25); // 50 chars, max 30
  const chunks = chunkContent(s, 30);
  for (const c of chunks) expect(c.length).toBeGreaterThanOrEqual(1);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
  expect(chunks.join("")).toBe(s);
});

test("chunkContent: default max is 8192", () => {
  expect(MAX_MSG_CHARS).toBe(8192);
  const s = "x".repeat(8192 * 2 + 5);
  const chunks = chunkContent(s);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(8192);
  expect(chunks.join("")).toBe(s);
});

test("chunkContent: empty string -> no chunks", () => {
  expect(chunkContent("")).toEqual([]);
});

// ── splitBatches ─────────────────────────────────────────────────────────────
test("splitBatches: <= maxPerBatch per batch, order + no loss", () => {
  const msgs: L0Message[] = Array.from({ length: 101 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: String(i),
  }));
  const batches = splitBatches(msgs, 100);
  expect(batches).toHaveLength(2);
  for (const b of batches) expect(b.length).toBeLessThanOrEqual(100);
  expect(batches.flat()).toEqual(msgs);
});

test("splitBatches: default max is 100", () => {
  expect(MAX_MSGS_PER_POST).toBe(100);
});

test("splitBatches: empty -> no batches", () => {
  expect(splitBatches([])).toEqual([]);
});

// ── selectScenarioPaths ──────────────────────────────────────────────────────
const ENTRIES = [
  { path: "工作/", summary: "dir" },
  { path: "工作/pi.md" },
  { path: "工作/交付物.md" },
  { path: "misc.md" },
];

test("selectScenarioPaths: no map -> inject all non-directory entries", () => {
  expect(selectScenarioPaths(ENTRIES, "/anywhere")).toEqual([
    "工作/pi.md",
    "工作/交付物.md",
    "misc.md",
  ]);
});

test("selectScenarioPaths: map prefix match -> mapped paths", () => {
  const map = { "/Users/plainwu/Working/ai/plain": ["工作/pi.md"] };
  expect(selectScenarioPaths(ENTRIES, "/Users/plainwu/Working/ai/plain/x", map)).toEqual(["工作/pi.md"]);
});

test("selectScenarioPaths: longest cwd prefix wins", () => {
  const map = {
    "/Users/plainwu/Working": ["a.md"],
    "/Users/plainwu/Working/ai/plain": ["b.md"],
  };
  expect(selectScenarioPaths(ENTRIES, "/Users/plainwu/Working/ai/plain", map)).toEqual(["b.md"]);
});

test("selectScenarioPaths: map present but no prefix match -> inject all", () => {
  const map = { "/elsewhere": ["nope.md"] };
  expect(selectScenarioPaths(ENTRIES, "/here", map)).toEqual(["工作/pi.md", "工作/交付物.md", "misc.md"]);
});

// ── assembleMemoryBlock ──────────────────────────────────────────────────────
test("assembleMemoryBlock: nothing to inject -> empty string", () => {
  expect(assembleMemoryBlock({ core: null, scenarios: [] })).toBe("");
  expect(assembleMemoryBlock({ core: "", scenarios: [] })).toBe("");
});

test("assembleMemoryBlock: core + scenario, within budget, correct shape", () => {
  const block = assembleMemoryBlock({
    core: "I am the core persona.",
    scenarios: [{ path: "工作/pi.md", summary: "project facts" }],
  });
  expect(block).toContain("I am the core persona.");
  expect(block).toContain("project facts");
  expect(block).toContain("工作/pi.md");
  expect(block.length).toBeLessThanOrEqual(16000);
  expect(block.trimStart().startsWith("<tdai-memory>")).toBe(true);
});

test("assembleMemoryBlock: core before scenarios in output order", () => {
  const block = assembleMemoryBlock({
    core: "CORE_MARKER",
    scenarios: [{ path: "s.md", summary: "SCENE_MARKER" }],
  });
  expect(block.indexOf("CORE_MARKER")).toBeLessThan(block.indexOf("SCENE_MARKER"));
});

test("assembleMemoryBlock: strips a trailing '## 🗺️' scene-nav block from core", () => {
  const block = assembleMemoryBlock({ core: "persona line\n## 🗺️\n- nav item", scenarios: [] });
  expect(block).toContain("persona line");
  expect(block).not.toContain("nav item");
});

test("assembleMemoryBlock: drops scenarios that exceed the budget", () => {
  const scenarios = Array.from({ length: 8 }, (_, i) => ({ path: `s${i}.md`, summary: "x".repeat(60) }));
  const block = assembleMemoryBlock({ core: "core", scenarios, budgetChars: 400 });
  expect(block.length).toBeLessThanOrEqual(400);
  expect(block).toContain("core");
  expect(block).toContain("s0.md");
  expect(block).not.toContain("s7.md"); // later ones dropped
});

test("assembleMemoryBlock: truncates L2 summaries to 200 chars", () => {
  const block = assembleMemoryBlock({ core: null, scenarios: [{ path: "p.md", summary: "y".repeat(500) }] });
  expect(block).toContain("y".repeat(200));
  expect(block).not.toContain("y".repeat(201));
});

test("assembleMemoryBlock: atomic hits alone -> a Recent Memories section", () => {
  const block = assembleMemoryBlock({
    core: null,
    scenarios: [],
    atomicHits: [{ content: "vouchers ship in farm2" }],
  });
  expect(block).toContain("### Recent Memories");
  expect(block).toContain("vouchers ship in farm2");
});

test("assembleMemoryBlock: section order is Core, Scenarios, then Recent Memories", () => {
  const block = assembleMemoryBlock({
    core: "CORE_MARKER",
    scenarios: [{ path: "s.md", summary: "SCENE_MARKER" }],
    atomicHits: [{ content: "ATOM_MARKER" }],
  });
  expect(block.indexOf("CORE_MARKER")).toBeLessThan(block.indexOf("SCENE_MARKER"));
  expect(block.indexOf("SCENE_MARKER")).toBeLessThan(block.indexOf("ATOM_MARKER"));
});

test("assembleMemoryBlock: atomic hits fall back to the text key", () => {
  const block = assembleMemoryBlock({ core: null, scenarios: [], atomicHits: [{ text: "fallback fact" }] });
  expect(block).toContain("fallback fact");
});

test("assembleMemoryBlock: an atom with neither content nor text contributes no empty bullet", () => {
  const block = assembleMemoryBlock({ core: null, scenarios: [], atomicHits: [{}] });
  expect(block).toBe(""); // nothing anywhere else either -> nothing at all
});

test("assembleMemoryBlock: atomic hit content truncated to ATOMIC_SUMMARY_MAX chars", () => {
  expect(ATOMIC_SUMMARY_MAX).toBe(200);
  const block = assembleMemoryBlock({ core: null, scenarios: [], atomicHits: [{ content: "y".repeat(500) }] });
  expect(block).toContain("y".repeat(200));
  expect(block).not.toContain("y".repeat(201));
});

test("assembleMemoryBlock: drops atomic hits that exceed the budget", () => {
  const atomicHits = Array.from({ length: 8 }, (_, i) => ({ content: `atom${i}-` + "x".repeat(60) }));
  const block = assembleMemoryBlock({ core: "core", scenarios: [], atomicHits, budgetChars: 400 });
  expect(block.length).toBeLessThanOrEqual(400);
  expect(block).toContain("atom0-");
  expect(block).not.toContain("atom7-"); // later ones dropped, same discipline as scenarios
});

test("assembleMemoryBlock: omitting atomicHits entirely behaves exactly as before (no regression)", () => {
  const block = assembleMemoryBlock({ core: "persona", scenarios: [{ path: "s.md" }] });
  expect(block).not.toContain("Recent Memories");
});

// ── atomicHitsFrom ───────────────────────────────────────────────────────────
test("atomicHitsFrom: reads the observed key and the defended ones", () => {
  const hits = [{ content: "a fact" }];
  expect(atomicHitsFrom({ results: hits })).toEqual(hits);
  expect(atomicHitsFrom({ memories: hits })).toEqual(hits);
  expect(atomicHitsFrom({ list: hits })).toEqual(hits);
  expect(atomicHitsFrom({ entries: hits })).toEqual(hits);
  expect(atomicHitsFrom(hits)).toEqual(hits); // a bare array
});

test("atomicHitsFrom: anything unrecognizable is no hits, never a throw", () => {
  expect(atomicHitsFrom(null)).toEqual([]);
  expect(atomicHitsFrom(undefined)).toEqual([]);
  expect(atomicHitsFrom({ unrelated: 1 })).toEqual([]);
  expect(atomicHitsFrom(["not", "objects"])).toEqual([]);
  expect(atomicHitsFrom("a string")).toEqual([]);
});

// ── atomicFingerprint / sameFingerprint ──────────────────────────────────────
test("atomicFingerprint: sorted content strings, blanks dropped", () => {
  expect(atomicFingerprint([{ content: "b" }, { content: "a" }, { content: "  " }])).toEqual(["a", "b"]);
});

test("atomicFingerprint: order of the input hits does not change the fingerprint", () => {
  const fp1 = atomicFingerprint([{ content: "x" }, { content: "y" }]);
  const fp2 = atomicFingerprint([{ content: "y" }, { content: "x" }]);
  expect(fp1).toEqual(fp2);
});

test("sameFingerprint: null previous never matches, even an empty current", () => {
  expect(sameFingerprint(null, [])).toBe(false);
});

test("sameFingerprint: equal arrays match, different ones don't", () => {
  expect(sameFingerprint(["a", "b"], ["a", "b"])).toBe(true);
  expect(sameFingerprint(["a", "b"], ["a", "c"])).toBe(false);
  expect(sameFingerprint(["a"], ["a", "b"])).toBe(false);
});

test("atomicFingerprint: matches what actually renders — hits differing only past ATOMIC_SUMMARY_MAX fingerprint identically", () => {
  // Found by review: fingerprinting the FULL text while rendering a TRUNCATED line
  // meant two hits differing only past char 200 got DIFFERENT fingerprints but
  // byte-identical rendered output, defeating the dedup on exactly the case it
  // exists to catch.
  const hitA = { content: "x".repeat(200) + "AAAA" };
  const hitB = { content: "x".repeat(200) + "BBBB" };
  const fpA = atomicFingerprint([hitA]);
  const fpB = atomicFingerprint([hitB]);
  expect(fpA).toEqual(fpB);
  // and the rendered block really is identical, proving the fingerprints were
  // right to treat them as the same turn's hits
  const blockA = assembleMemoryBlock({ core: null, scenarios: [], atomicHits: [hitA] });
  const blockB = assembleMemoryBlock({ core: null, scenarios: [], atomicHits: [hitB] });
  expect(blockA).toBe(blockB);
});

// ── isKillSwitchOff ──────────────────────────────────────────────────────────
test("isKillSwitchOff: both documented and legacy spellings disable", () => {
  expect(isKillSwitchOff("off")).toBe(true);
  expect(isKillSwitchOff("OFF")).toBe(true);
  expect(isKillSwitchOff("0")).toBe(true);
});

test("isKillSwitchOff: unset, on, or anything else means enabled", () => {
  expect(isKillSwitchOff(undefined)).toBe(false);
  expect(isKillSwitchOff("")).toBe(false);
  expect(isKillSwitchOff("on")).toBe(false);
  expect(isKillSwitchOff("1")).toBe(false);
});

// ── normalizeEntries ─────────────────────────────────────────────────────────
const msg = (role: string, content: unknown, extra: Record<string, unknown> = {}): SessionEntryLike => ({
  type: "message",
  id: Math.random().toString(36).slice(2),
  message: { role, content, ...extra },
});

test("normalizeEntries: user text -> one user message", () => {
  const out = normalizeEntries([msg("user", [{ type: "text", text: "hi" }])]);
  expect(out).toEqual([{ role: "user", content: "hi" }]);
});

test("normalizeEntries: assistant text + thinking dropped + toolCall -> assistant text", () => {
  const out = normalizeEntries([
    msg("assistant", [
      { type: "text", text: "let me check" },
      { type: "thinking", thinking: "hidden reasoning" },
      { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
    ]),
  ]);
  expect(out).toHaveLength(1);
  expect(out[0].role).toBe("assistant");
  expect(out[0].content).toContain("let me check");
  expect(out[0].content).toContain("bash");
  expect(out[0].content).not.toContain("hidden reasoning");
});

test("normalizeEntries: toolResult -> user message with name + text", () => {
  const out = normalizeEntries([
    msg("toolResult", [{ type: "text", text: "file listing" }], { toolName: "read" }),
  ]);
  expect(out).toEqual([{ role: "user", content: "[tool_result name=read] file listing" }]);
});

test("normalizeEntries: ignores non-message entries", () => {
  const out = normalizeEntries([
    { type: "compaction", id: "x" },
    { type: "custom_message", id: "y" },
    msg("user", [{ type: "text", text: "kept" }]),
  ]);
  expect(out).toEqual([{ role: "user", content: "kept" }]);
});

test("normalizeEntries: long content is chunked to <= 8192 chars, no loss", () => {
  const big = "q".repeat(20000);
  const out = normalizeEntries([msg("assistant", [{ type: "text", text: big }])]);
  expect(out.length).toBeGreaterThan(1);
  for (const m of out) expect(m.content.length).toBeLessThanOrEqual(MAX_MSG_CHARS);
  expect(out.map((m) => m.content).join("")).toBe(big);
});

test("normalizeEntries: empty content is dropped", () => {
  const out = normalizeEntries([msg("assistant", [{ type: "thinking", thinking: "only thinking" }])]);
  expect(out).toEqual([]);
});

// ── missingRequiredEnv (fail-fast) ──────────────────────────────────────────
const fullEnv: Record<string, string> = {
  TDAI_API_KEY: "k",
  TDAI_GATEWAY_URL: "http://gw",
  TDAI_KNOWLEDGE_URL: "http://kn",
  TDAI_SERVICE_ID: "default",
  TDAI_TEAM_ID: "team",
  TDAI_USER_ID: "usr",
  TDAI_AGENT_ID: "agt",
};

test("missingRequiredEnv: all set -> []", () => {
  expect(missingRequiredEnv(fullEnv)).toEqual([]);
});

test("missingRequiredEnv: none set -> the full REQUIRED_ENV list", () => {
  expect(missingRequiredEnv({})).toEqual([...REQUIRED_ENV]);
});

test("missingRequiredEnv: reports exactly the unset ones", () => {
  const rest: Record<string, string> = { ...fullEnv };
  delete rest.TDAI_GATEWAY_URL;
  expect(missingRequiredEnv(rest)).toEqual(["TDAI_GATEWAY_URL"]);
});

test("missingRequiredEnv: empty string counts as missing", () => {
  expect(missingRequiredEnv({ ...fullEnv, TDAI_API_KEY: "" })).toEqual(["TDAI_API_KEY"]);
});
