/**
 * Parser for memory import files (.md / .json / .txt).
 *
 * Used by POST /chat-memory/import-memories to split user-supplied content
 * into individual L1 atomic memory records before batch-writing via
 * /v3/atomic/create.
 *
 * Splitting strategies:
 *   - Markdown (.md): split by `##` headings; each section becomes one record
 *     (heading + body). If no headings, fall back to paragraph splitting.
 *   - JSON (.json): expect an array of {content, type?, scene_name?, priority?}.
 *   - Text (.txt): split by blank lines; each non-empty paragraph is a record.
 */

export interface ParsedMemoryRecord {
  content: string;
  type?: "persona" | "episodic" | "instruction" | "work_fact" | "work_task" | "work_method" | "work_artifact";
  scene_name?: string;
  priority?: number;
  metadata?: Record<string, unknown>;
}

export interface ParseResult {
  records: ParsedMemoryRecord[];
  format: "markdown" | "json" | "text";
  truncated: number;  // records dropped due to >8192 char content limit
}

const MAX_CONTENT_LENGTH = 8192;

/**
 * Parse a file's text content into memory records based on filename extension.
 */
export function parseMemoryFile(filename: string, text: string): ParseResult {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "md":
    case "markdown":
      return parseMarkdown(text);
    case "json":
      return parseJson(text);
    case "txt":
    case "text":
      return parseText(text);
    default:
      // Fallback: try JSON first, then markdown, then text
      try {
        JSON.parse(text);
        return parseJson(text);
      } catch {
        return parseMarkdown(text);
      }
  }
}

/**
 * Parse markdown by `##` headings. Each heading + its body becomes one record.
 * If no headings found, split by blank-line paragraphs.
 */
function parseMarkdown(text: string): ParseResult {
  const records: ParsedMemoryRecord[] = [];
  let truncated = 0;

  // Try splitting by `##` headings first
  const headingRe = /^##\s+(.+)$/gm;
  const matches = [...text.matchAll(headingRe)];

  if (matches.length > 0) {
    // Split content at each `##` heading
    const parts = text.split(/^(?=##\s+)/m);
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const content = trimmed.length > MAX_CONTENT_LENGTH
        ? trimmed.slice(0, MAX_CONTENT_LENGTH)
        : trimmed;
      if (trimmed.length > MAX_CONTENT_LENGTH) truncated++;
      records.push({ content, type: "persona" });
    }
  } else {
    // No headings — split by blank-line paragraphs
    const paragraphs = text.split(/\n\s*\n/);
    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!trimmed) continue;
      const content = trimmed.length > MAX_CONTENT_LENGTH
        ? trimmed.slice(0, MAX_CONTENT_LENGTH)
        : trimmed;
      if (trimmed.length > MAX_CONTENT_LENGTH) truncated++;
      records.push({ content, type: "persona" });
    }
  }

  return { records, format: "markdown", truncated };
}

/**
 * Parse JSON array of memory records. Each element should have at least `content`.
 */
function parseJson(text: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { records: [], format: "json", truncated: 0 };
  }

  if (!Array.isArray(parsed)) {
    // Single object with content — wrap as one-element array
    if (parsed && typeof parsed === "object" && typeof (parsed as any).content === "string") {
      parsed = [parsed];
    } else {
      return { records: [], format: "json", truncated: 0 };
    }
  }

  const records: ParsedMemoryRecord[] = [];
  let truncated = 0;

  for (const item of parsed as any[]) {
    if (!item || typeof item !== "object") continue;
    const content = typeof item.content === "string" ? item.content : "";
    if (!content.trim()) continue;
    const finalContent = content.length > MAX_CONTENT_LENGTH
      ? content.slice(0, MAX_CONTENT_LENGTH)
      : content;
    if (content.length > MAX_CONTENT_LENGTH) truncated++;
    records.push({
      content: finalContent,
      type: item.type,
      scene_name: item.scene_name ?? item.scene,
      priority: typeof item.priority === "number" ? item.priority : undefined,
      metadata: item.metadata,
    });
  }

  return { records, format: "json", truncated };
}

/**
 * Parse plain text by blank-line paragraphs.
 */
function parseText(text: string): ParseResult {
  const records: ParsedMemoryRecord[] = [];
  let truncated = 0;

  const paragraphs = text.split(/\n\s*\n/);
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    const content = trimmed.length > MAX_CONTENT_LENGTH
      ? trimmed.slice(0, MAX_CONTENT_LENGTH)
      : trimmed;
    if (trimmed.length > MAX_CONTENT_LENGTH) truncated++;
    records.push({ content, type: "persona" });
  }

  return { records, format: "text", truncated };
}
