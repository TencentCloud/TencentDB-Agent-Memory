// extensions/tdai-memory/lib.ts
// Pure, dependency-free logic for the tdai-memory pi extension:
//   - L0 capture: normalize a pi session into user/assistant messages
//   - L2/L3 injection: select scenarios + assemble the budgeted prompt block
// No pi imports, no network — unit-testable in isolation.

export const MAX_MSG_CHARS = 8192; // tdai conversation/add: content 1..8192 JS chars
export const MAX_MSGS_PER_POST = 100; // tdai conversation/add: 1..100 messages per POST
export const DEFAULT_BUDGET_CHARS = 16000; // ~4K tokens of injected memory
export const SUMMARY_MAX = 200; // L2 summary length cap (proxy renders path + ≤200-char summary, no body)

export interface ScenarioEntry {
  path: string;
  summary?: string;
}
/** One L1 atomic-search hit. Shape is opaque server-side (never asserted elsewhere in
 * this file); `content` is the field the ADLC harness's own tdai client (same backend,
 * same endpoint) found the notes under. */
export interface AtomicHit {
  content?: string;
  text?: string;
}
export interface MemoryBlockInput {
  core?: string | null;
  /** L2 scenarios to inject: path + optional summary (proxy-faithful: path + ≤200-char summary, no full body). */
  scenarios: ScenarioEntry[];
  /** L1 atoms found by searching THIS TURN's own incoming prompt text — the per-turn
   * proxy-mimic push. Optional: omitted (or empty) turns render no "Recent Memories"
   * section at all, distinct from a turn whose hits are present but deduped away by
   * the caller before this is even called. */
  atomicHits?: AtomicHit[];
  budgetChars?: number;
}
export interface L0Message {
  role: "user" | "assistant";
  content: string;
}

/** Minimal view of a pi session entry — only the fields the normalizer reads. */
export interface SessionEntryLike {
  type: string;
  id: string;
  message?: {
    role?: string;
    content?: unknown;
    toolName?: string;
    toolCallId?: string;
  };
}

/** A content part of a pi message (text / toolCall / ...). Only fields we read. */
interface ContentPart {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

/** Split a string into pieces of 1..max chars (UTF-16 units), order preserved, no loss. Empty -> []. */
export function chunkContent(s: string, max: number = MAX_MSG_CHARS): string[] {
  if (s.length === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += max) {
    let end = i + max;
    // Don't split a UTF-16 surrogate pair at the boundary (e.g. emoji).
    if (end < s.length && s.charCodeAt(end) >= 0xdc00 && s.charCodeAt(end) <= 0xdfff) end -= 1;
    out.push(s.slice(i, end));
  }
  return out;
}

/** Split a flat message list into batches of at most maxPerBatch, order preserved. Empty -> []. */
export function splitBatches(messages: L0Message[], maxPerBatch: number = MAX_MSGS_PER_POST): L0Message[][] {
  if (messages.length === 0) return [];
  const out: L0Message[][] = [];
  for (let i = 0; i < messages.length; i += maxPerBatch) out.push(messages.slice(i, i + maxPerBatch));
  return out;
}

/**
 * Choose which L2 scenario paths to inject for a cwd.
 * If `map` has a key that is a prefix of `cwd`, return the longest match's paths.
 * Otherwise return every non-directory entry (inject-all).
 */
export function selectScenarioPaths(
  entries: ScenarioEntry[],
  cwd: string,
  map?: Record<string, string[]>,
): string[] {
  if (map) {
    let bestKey: string | null = null;
    for (const key of Object.keys(map)) {
      if (cwd.startsWith(key) && (bestKey === null || key.length > bestKey.length)) bestKey = key;
    }
    if (bestKey !== null) return map[bestKey];
  }
  return entries.filter((e) => !e.path.endsWith("/")).map((e) => e.path);
}

/** Join the text parts of a message's content (string or array-of-parts). */
function partText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && typeof (p as ContentPart).text === "string" ? (p as ContentPart).text : ""))
      .join("\n");
  }
  return "";
}

/** Drop a trailing scene-navigation block (a line starting with "## 🗺️"). */
function stripSceneNav(s: string): string {
  const lines = s.split("\n");
  const cut = lines.findIndex((l) => l.trimStart().startsWith("## 🗺️"));
  return cut === -1 ? s : lines.slice(0, cut).join("\n").trimEnd();
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return String(v);
  }
}

/** One L2 scenario line: path + optional ≤SUMMARY_MAX-char summary (proxy-faithful). */
function scenarioLine(s: ScenarioEntry): string {
  const summary = (s.summary ?? "").trim().slice(0, SUMMARY_MAX);
  return summary ? `- ${s.path}: ${summary}` : `- ${s.path}`;
}

/** L1 atomic-hit summary cap — same 200-char ceiling as an L2 summary line; atoms are
 * the memory's own already-distilled notes, not full pages, so a shorter cap than a
 * wiki page would need is the right size here too. */
export const ATOMIC_SUMMARY_MAX = 200;

function atomicLine(hit: AtomicHit): string {
  const text = (hit.content ?? hit.text ?? "").trim().slice(0, ATOMIC_SUMMARY_MAX);
  return text ? `- ${text}` : "";
}

/**
 * Assemble the <tdai-memory> prompt block: L3 core (full, truncated to fit) first,
 * then selected L2 scenarios, then L1 atomic hits (the spec-18-style per-turn push),
 * as "- text" lines, everything within budgetChars.
 * Returns "" when there is nothing to inject.
 */
export function assembleMemoryBlock(input: MemoryBlockInput): string {
  const budget = input.budgetChars ?? DEFAULT_BUDGET_CHARS;
  const header = "<tdai-memory>\n";
  const footer = "\n</tdai-memory>";

  const coreText = stripSceneNav((input.core ?? "").trim());
  const scenes = input.scenarios.filter((s) => s.path);
  const atoms = (input.atomicHits ?? []).map(atomicLine).filter(Boolean);
  if (!coreText && scenes.length === 0 && atoms.length === 0) return "";

  // L3 core first, truncated to fit on its own.
  let coreBlock = "";
  if (coreText) {
    const coreLine = "### Core\n";
    const allow = Math.max(0, budget - header.length - footer.length - coreLine.length);
    coreBlock = `### Core\n${allow >= coreText.length ? coreText : coreText.slice(0, allow)}`;
  }

  const render = (sceneLines: string[], atomicLines: string[]) => {
    const blocks = [
      ...(coreBlock ? [coreBlock] : []),
      ...(sceneLines.length ? [`### Scenarios\n${sceneLines.join("\n")}`] : []),
      ...(atomicLines.length ? [`### Recent Memories\n${atomicLines.join("\n")}`] : []),
    ];
    return header + blocks.join("\n\n") + footer;
  };

  // L2 lines, added in order while within budget. NOTE (found by review): this loop
  // checks against `render([...sceneLines, line], [])` — as if no atomic section
  // existed — so scenes always get first claim on the budget and can starve atoms
  // entirely in a caller that passes BOTH scenarios and atomicHits in one call.
  // Not reachable today: index.ts's two call sites never combine them (the
  // once-per-session push sends scenarios only, the per-turn push sends atoms
  // only) — but this function is shared, and a future caller combining both should
  // budget them together rather than assume this ordering is fair.
  const sceneLines: string[] = [];
  for (const s of scenes) {
    const line = scenarioLine(s);
    if (render([...sceneLines, line], []).length <= budget) sceneLines.push(line);
  }

  // L1 lines, added in order while within budget — scenes already settled above.
  const atomicLines: string[] = [];
  for (const a of atoms) {
    if (render(sceneLines, [...atomicLines, a]).length <= budget) atomicLines.push(a);
  }

  return render(sceneLines, atomicLines);
}

/**
 * Pull the hit list out of an atomic-search response — pure, defensive. The response
 * shape is opaque here (no schema asserted anywhere in this codebase, since
 * `tdai_search` the TOOL just forwards raw data to the model); this defends the SAME
 * keys the ADLC harness's own tdai client found against the identical backend
 * endpoint (`results` observed live; `memories`/`list` defended the same way;
 * `entries` added defensively since this extension's OWN `/v3/scenario/ls` uses that
 * key and the two endpoints could plausibly share a response convention). A bare
 * array is accepted too. Anything unrecognizable is no hits, never a throw.
 */
export function atomicHitsFrom(data: unknown): AtomicHit[] {
  const isHit = (h: unknown): h is AtomicHit => !!h && typeof h === "object";
  if (Array.isArray(data)) return data.filter(isHit);
  if (data && typeof data === "object") {
    for (const key of ["results", "memories", "list", "entries"] as const) {
      const v = (data as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v.filter(isHit);
    }
  }
  return [];
}

/** The dedup key for this turn's atomic hits — sorted, so a ranking-order change
 * alone (plausible noise from the search backend) does not defeat the dedup.
 * Truncated to ATOMIC_SUMMARY_MAX, same as `atomicLine`'s own render cap — found by
 * review: fingerprinting the FULL text while rendering a TRUNCATED line meant two
 * hits differing only past char 200 got different fingerprints but byte-identical
 * rendered output, defeating the dedup on exactly the case it exists to catch. */
export function atomicFingerprint(hits: AtomicHit[]): string[] {
  return hits
    .map((h) => (h.content ?? h.text ?? "").trim().slice(0, ATOMIC_SUMMARY_MAX))
    .filter(Boolean)
    .sort();
}

/** Fingerprint equality — `null` (no previous turn, or the previous turn was an
 * outage) never matches anything, so the very next turn after either always renders
 * fresh rather than being spuriously suppressed. */
export function sameFingerprint(a: string[] | null, b: string[]): boolean {
  if (a === null) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * Normalize pi session entries into tdai L0 messages (user/assistant only).
 * thinking dropped; toolCall -> assistant text; toolResult -> user text;
 * long content chunked to <= MAX_MSG_CHARS; empty messages dropped; order preserved.
 */
export function normalizeEntries(entries: SessionEntryLike[]): L0Message[] {
  const out: L0Message[] = [];
  const push = (role: "user" | "assistant", text: string) => {
    for (const piece of chunkContent(text)) out.push({ role, content: piece });
  };

  for (const e of entries) {
    if (e.type !== "message" || !e.message) continue;
    const m = e.message;

    if (m.role === "user") {
      const t = partText(m.content).trim();
      if (t) push("user", t);
    } else if (m.role === "assistant") {
      const parts: string[] = [];
      if (Array.isArray(m.content)) {
        for (const raw of m.content as ContentPart[]) {
          if (!raw || typeof raw !== "object") continue;
          if (raw.type === "text" && typeof raw.text === "string") {
            parts.push(raw.text);
          } else if (raw.type === "toolCall") {
            parts.push(`[tool_call id=${raw.id ?? ""} name=${raw.name ?? ""} ${safeJson(raw.arguments ?? {})}]`);
          }
          // "thinking" and anything else: intentionally dropped
        }
      } else if (typeof m.content === "string") {
        parts.push(m.content);
      }
      const t = parts.filter((x) => x.trim()).join("\n").trim();
      if (t) push("assistant", t);
    } else if (m.role === "toolResult") {
      const t = partText(m.content).trim();
      if (t) push("user", `[tool_result name=${m.toolName ?? ""}] ${t}`);
    }
  }

  return out;
}

// ── Config validation (fail-fast: no silent defaults) ───────────────────────
/** Env vars the extension requires. If any is unset, the extension refuses to load. */
export const REQUIRED_ENV = [
  "TDAI_API_KEY",
  "TDAI_GATEWAY_URL",
  "TDAI_KNOWLEDGE_URL",
  "TDAI_SERVICE_ID",
  "TDAI_TEAM_ID",
  "TDAI_USER_ID",
  "TDAI_AGENT_ID",
] as const;

/** Return the required env vars that are unset/empty in `env`. Empty array = all present. */
export function missingRequiredEnv(env: Record<string, string | undefined>): string[] {
  return REQUIRED_ENV.filter((k) => !env[k]);
}

/** Whether a TDAI_INJECT / TDAI_CAPTURE kill-switch value means "disabled" — found by
 * review: the code used to check ONLY `=== "0"`, while README.md documents `off` as
 * the value to set. A user following the README's own instructions had the switch
 * silently do nothing — pre-existing, but this refactor raised the stakes: injection
 * now costs a visible message plus an extra HTTP call every turn, not an invisible
 * splice, so a kill switch that does not kill anything matters more than it used to.
 * Both spellings accepted going forward; case-insensitive. */
export function isKillSwitchOff(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "0" || v === "off";
}
