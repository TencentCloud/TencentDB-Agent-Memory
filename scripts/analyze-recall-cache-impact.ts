import {
  analyzeRecallInjectionImpact,
  buildInjectedUserText,
  stripRelevantMemoriesFromText,
  type RecallInjectionTurn,
} from "../src/utils/recall-injection.js";

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
