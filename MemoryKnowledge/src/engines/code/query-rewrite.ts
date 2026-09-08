/**
 * Code-graph indexes English identifiers. Chinese / CJK natural-language
 * queries have no lexical overlap and used to return "No relevant code found".
 * When an LLM is configured, rewrite the question into identifier tokens and
 * retry; otherwise surface a clear hint.
 */

export const REWRITEABLE_TOOLS = new Set(["codegraph_explore", "codegraph_search"]);

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
const EMPTY_HIT_RE = /no relevant code found/i;

export type ChatFn = (params: {
  system: string;
  prompt: string;
  label?: string;
  maxOutputTokens?: number;
}) => Promise<string>;

export const REWRITE_SYSTEM = `You map a codebase question to English identifier search tokens.
The index only matches class / function / file / method names (usually English).
Reply with 3 to 8 space-separated identifier tokens on one line.
No punctuation, no quotes, no explanation.
Prefer common programming names (Search, Service, Filter, Query, Rank, Auth).
If the input is already identifier-like, repeat those identifiers.`;

export function hasCjk(query: string): boolean {
  return CJK_RE.test(query);
}

export function isEmptySymbolHit(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "" || EMPTY_HIT_RE.test(trimmed);
}

/** Keep identifier-like tokens from an LLM one-liner. */
export function parseIdentifierTokens(raw: string): string | null {
  const line = raw.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? "";
  const tokens = line
    .replace(/[`"'，。、；：]/g, " ")
    .split(/[\s,;|/]+/)
    .map((t) => t.replace(/[^A-Za-z0-9_.-]/g, ""))
    .filter((t) => t.length >= 2 && /[A-Za-z]/.test(t))
    .slice(0, 8);
  if (tokens.length === 0) return null;
  return tokens.join(" ");
}

export async function rewriteQueryToIdentifiers(
  query: string,
  chat: ChatFn,
): Promise<string | null> {
  const raw = await chat({
    system: REWRITE_SYSTEM,
    prompt: query,
    label: "code-graph-query-rewrite",
    maxOutputTokens: 64,
  });
  const tokens = parseIdentifierTokens(raw);
  if (!tokens || tokens.toLowerCase() === query.trim().toLowerCase()) return null;
  return tokens;
}

export function emptyHitHint(original: string, rewritten?: string): string {
  const rewriteNote = rewritten
    ? ` Tried rewritten tokens "${rewritten}".`
    : "";
  return (
    `No relevant code found for "${original}".` +
    rewriteNote +
    " Code-graph matches English identifiers (class / function / file names)." +
    " Ask with a symbol name, or configure Knowledge LLM so Chinese questions can be rewritten."
  );
}
