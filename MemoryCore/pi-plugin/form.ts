/**
 * Proxy session-init form protocol helpers.
 *
 * The TDAI proxy's CodeBuddy state machine emits its Team/Agent/Task picker as
 * an `ask_followup_question` tool_call whose `function.arguments` is a JSON
 * string of shape `{ title: string, questions: string }` — and `questions` is
 * ITSELF a JSON string (double-encoded) of `SessionInitQuestion[]`.
 *
 * The answer is returned as `<question_answer>` XML so the proxy's
 * `extractFromOptionText` → `parseQuestionAnswerXml` can split a combined
 * agent+task form into per-question answers (see RFC §3).
 */

export interface SessionInitQuestion {
  id: string;
  question: string;
  options: string[];
  multiSelect: boolean;
}
export interface SessionInitForm {
  title: string;
  questions: SessionInitQuestion[];
}

/**
 * Parse the proxy's `ask_followup_question` arguments. Accepts either:
 *  - the raw `function.arguments` JSON string (double-decodes), or
 *  - the already-parsed object `{ title, questions: string }` (Pi parses
 *    `function.arguments` against the tool's `parameters` schema before
 *    calling `execute`, so `params` arrives parsed — `questions` is still the
 *    inner JSON string).
 * Returns `null` when `input` is not a valid session-init form, so the tool
 * can no-op for unrelated calls.
 */
export function parseFormArgs(input: string | object): SessionInitForm | null {
  let outer: unknown;
  if (typeof input === "string") {
    try {
      outer = JSON.parse(input);
    } catch {
      return null;
    }
  } else if (input && typeof input === "object") {
    outer = input;
  } else {
    return null;
  }
  if (!outer || typeof outer !== "object") return null;
  const o = outer as { title?: unknown; questions?: unknown };
  if (typeof o.title !== "string") return null;
  // `questions` is a JSON string (the proxy double-encodes); decode it.
  if (typeof o.questions !== "string") return null;
  let qs: unknown;
  try {
    qs = JSON.parse(o.questions);
  } catch {
    return null;
  }
  if (!Array.isArray(qs)) return null;
  const questions: SessionInitQuestion[] = qs
    .map((q): SessionInitQuestion | null => {
      if (!q || typeof q !== "object") return null;
      const r = q as Record<string, unknown>;
      if (typeof r.id !== "string" || typeof r.question !== "string" || !Array.isArray(r.options) || typeof r.multiSelect !== "boolean") return null;
      return {
        id: r.id,
        question: r.question,
        options: (r.options as unknown[]).filter((x): x is string => typeof x === "string"),
        multiSelect: r.multiSelect,
      };
    })
    .filter((q): q is SessionInitQuestion => q !== null);
  if (questions.length === 0) return null;
  return { title: o.title, questions };
}

/**
 * Build the `<question_answer>` XML the proxy's extractor expects. One
 * `<question_item id="…">` per answer, each wrapping the EXACT option label
 * the proxy sent (the extractor matches by full label first).
 */
export function formatAnswerXml(answers: { id: string; answer: string }[]): string {
  const items = answers
    .map((a) => `<question_item id="${a.id}"><answers>${escapeXml(a.answer)}</answers></question_item>`)
    .join("");
  return `<question_answer><questions>${items}</questions></question_answer>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
