import {
  analyzeRecallInjectionImpact,
  buildInjectedUserText,
  stripRelevantMemoriesFromText,
  type RecallInjectionTurn,
} from "../src/utils/recall-injection.js";
import {
  analyzeStableContextStability,
  composeStableSystemContext,
} from "../src/core/hooks/recall-stable-context.js";

interface ReplayRow {
  turn: number;
  cleanHistoryChars: number;
  injectedHistoryChars: number;
  extraHistoryChars: number;
  cleanPromptChars: number;
  injectedPromptChars: number;
  commonPrefixCleanChars: number;
  commonPrefixInjectedChars: number;
}

const SYSTEM_PROMPT = [
  "You are OpenClaw with TencentDB Agent Memory enabled.",
  "<memory-tools-guide>Use tdai_memory_search only when injected context is insufficient.</memory-tools-guide>",
].join("\n");

const TURNS: RecallInjectionTurn[] = [
  {
    userText: "Please help me prepare the weekly database operations summary.",
    prependContext: "<relevant-memories>\n- [preference] User prefers concise status bullets.\n- [project] Weekly DB report tracks latency, backup, and incident follow-up.\n</relevant-memories>",
  },
  {
    userText: "Add the backup verification status and note any risky services.",
    prependContext: "<relevant-memories>\n- [project] Backup verification must mention PITR coverage.\n- [risk] Service alpha-db had slow query alerts last Friday.\n</relevant-memories>",
  },
  {
    userText: "Now turn it into an executive-facing version.",
    prependContext: "<relevant-memories>\n- [preference] Executives prefer one-line risk summaries first.\n- [format] Put action owners after each risk item.\n</relevant-memories>",
  },
  {
    userText: "Keep the same structure next time and remember the owner mapping.",
    prependContext: "<relevant-memories>\n- [owner] Alice owns backup verification.\n- [owner] Bob owns slow-query remediation.\n</relevant-memories>",
  },
];

function assistantText(turn: number): string {
  return `Assistant response ${turn}: acknowledged and produced the requested summary.`;
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

function buildPrompt(history: string, currentUserText: string): string {
  return `${SYSTEM_PROMPT}\n\n<history>\n${history}\n</history>\n\n<current-user>\n${currentUserText}\n</current-user>`;
}

function appendHistory(history: string, userText: string, assistant: string): string {
  const next = `user: ${userText}\nassistant: ${assistant}`;
  return history ? `${history}\n${next}` : next;
}

function replay(turns: RecallInjectionTurn[]): ReplayRow[] {
  let cleanHistory = "";
  let injectedHistory = "";
  let previousCleanPrompt = "";
  let previousInjectedPrompt = "";

  return turns.map((turn, index) => {
    const injectedUserText = buildInjectedUserText(turn);
    const cleanUserText = stripRelevantMemoriesFromText(injectedUserText).value;
    const cleanPrompt = buildPrompt(cleanHistory, injectedUserText);
    const injectedPrompt = buildPrompt(injectedHistory, injectedUserText);

    const row: ReplayRow = {
      turn: index + 1,
      cleanHistoryChars: cleanHistory.length,
      injectedHistoryChars: injectedHistory.length,
      extraHistoryChars: injectedHistory.length - cleanHistory.length,
      cleanPromptChars: cleanPrompt.length,
      injectedPromptChars: injectedPrompt.length,
      commonPrefixCleanChars: index === 0 ? 0 : commonPrefixLength(previousCleanPrompt, cleanPrompt),
      commonPrefixInjectedChars: index === 0 ? 0 : commonPrefixLength(previousInjectedPrompt, injectedPrompt),
    };

    cleanHistory = appendHistory(cleanHistory, cleanUserText, assistantText(index + 1));
    injectedHistory = appendHistory(injectedHistory, injectedUserText, assistantText(index + 1));
    previousCleanPrompt = cleanPrompt;
    previousInjectedPrompt = injectedPrompt;
    return row;
  });
}

function printTable(rows: ReplayRow[]): void {
  const headers = [
    "turn",
    "cleanHist",
    "injectedHist",
    "extraHist",
    "cleanPrompt",
    "injectedPrompt",
    "lcpClean",
    "lcpInjected",
  ];
  const body = rows.map((row) => [
    row.turn,
    row.cleanHistoryChars,
    row.injectedHistoryChars,
    row.extraHistoryChars,
    row.cleanPromptChars,
    row.injectedPromptChars,
    row.commonPrefixCleanChars,
    row.commonPrefixInjectedChars,
  ]);
  const widths = headers.map((header, index) => Math.max(header.length, ...body.map((line) => String(line[index]).length)));

  console.log(headers.map((header, index) => header.padStart(widths[index])).join("  "));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const line of body) {
    console.log(line.map((cell, index) => String(cell).padStart(widths[index])).join("  "));
  }
}

const rows = replay(TURNS);
const impact = analyzeRecallInjectionImpact(TURNS);

console.log("Recall injection cache-impact replay");
console.log("====================================");
printTable(rows);
console.log("");
console.log(`Extra persisted history chars with injected recall visible: ${impact.extraPersistedChars}`);
console.log(`Adjacent turns with changed dynamic recall prefix: ${impact.prefixChangeCount}`);
console.log("");
console.log("Interpretation:");
console.log("- cleanHist removes previous <relevant-memories> before persistence.");
console.log("- injectedHist keeps previous <relevant-memories> in future history.");
console.log("- lcp* is the longest common prefix with the previous full prompt.");

// ============================================================================
// System-prompt region stability (issue #120 secondary root cause, the fix)
// ============================================================================
//
// The system prompt is the most cache-sensitive region for prefix-matching
// providers. The bug: the memory tools guide (stable content) used to be
// appended based on whether *this turn* matched a dynamic L1 memory, so for a
// user without a persona the system region flipped between "guide" and "" —
// busting the system-prompt cache every other turn.
//
// The fix decouples the stable system region from per-turn dynamic recall:
// the guide follows stable persona/scene only. Below we replay a persona-less
// session with intermittent memory matches under both behaviors.

const GUIDE = "<memory-tools-guide>Use tdai_memory_search when injected context is insufficient.</memory-tools-guide>";

// Per-turn: did this turn's query match any dynamic L1 memory?
const MEMORY_MATCH_PER_TURN = [true, false, true, false, true, false];

// OLD behavior: guide (stable) appended whenever stable content OR this turn's
// dynamic memories were present. No persona/scene → region tracks the dynamic match.
const oldRegionPerTurn = MEMORY_MATCH_PER_TURN.map((matched) => (matched ? GUIDE : undefined));

// NEW behavior: stable region depends only on persona/scene, never on the
// per-turn match. Persona-less user → no stable region at all (constant).
const newRegionPerTurn = MEMORY_MATCH_PER_TURN.map(() =>
  composeStableSystemContext({ /* no persona/scene yet */ }, { toolsGuide: GUIDE }),
);

// Established user (has a persona): the region is now byte-stable every turn.
const establishedRegionPerTurn = MEMORY_MATCH_PER_TURN.map(() =>
  composeStableSystemContext({ personaContent: "User prefers concise bullets." }, { toolsGuide: GUIDE }),
);

const oldStability = analyzeStableContextStability(oldRegionPerTurn);
const newStability = analyzeStableContextStability(newRegionPerTurn);
const establishedStability = analyzeStableContextStability(establishedRegionPerTurn);

console.log("");
console.log("System-prompt region stability (before vs after the fix)");
console.log("========================================================");
console.log(`turns simulated: ${MEMORY_MATCH_PER_TURN.length} (memory match per turn: ${MEMORY_MATCH_PER_TURN.join(", ")})`);
console.log(`BEFORE (guide coupled to dynamic recall):     system-region changes = ${oldStability.changeCount}`);
console.log(`AFTER  (persona-less user, decoupled):        system-region changes = ${newStability.changeCount}`);
console.log(`AFTER  (established user with persona):        system-region changes = ${establishedStability.changeCount}`);
console.log("");
console.log("Interpretation:");
console.log("- Fewer system-region changes = a longer stable prefix = higher prompt-cache hit rate.");
console.log("- The fix removes per-turn flips in the cache-sensitive system prompt region.");
