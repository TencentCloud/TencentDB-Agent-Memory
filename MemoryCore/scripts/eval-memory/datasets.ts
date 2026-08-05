/**
 * eval-memory — dataset adapters.
 *
 * Every dataset is normalized to EvalDataset (conversations → sessions →
 * strictly-alternating rounds + judged questions), so the runner never
 * knows which benchmark it is executing. Adding a benchmark = adding an
 * adapter here.
 *
 * Built-in adapters:
 *  - synthetic: a tiny offline smoke set (no download, deterministic).
 *  - locomo:    LoCoMo (Maharana et al., ACL 2024), 10 multi-session
 *               conversations, ~300 judged questions. The dataset is
 *               CC BY-NC 4.0 and is therefore NEVER vendored into this
 *               repo — it is fetched from the official source at run
 *               time (or read from --locomo-path).
 *               https://github.com/snap-research/locomo
 */

import { readFileSync } from "node:fs";

import type {
  EvalConversation,
  EvalDataset,
  EvalQuestion,
  EvalSession,
  QuestionCategory,
} from "./types.js";

export const LOCOMO_DEFAULT_URL =
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json";

/**
 * LoCoMo qa `category` labels, matching task_eval/evaluation.py in the
 * official repo (multi-hop=1 is scored with sub-answer partial F1 there;
 * 2/3/4 are scored whole; 5 is the adversarial option-selection set).
 */
const LOCOMO_CATEGORY: Record<number, QuestionCategory> = {
  1: "multi-hop",
  2: "temporal",
  3: "open-domain",
  4: "single-hop",
  5: "adversarial",
};

// ============================
// Synthetic smoke set
// ============================

/**
 * Small enough to run end-to-end in minutes on any OpenAI-compatible
 * endpoint, with unambiguous gold answers. Useful as a wiring check
 * before paying for a full LoCoMo run — not as a quality benchmark.
 */
export function buildSyntheticDataset(): EvalDataset {
  const sessions: EvalSession[] = [
    {
      sessionKey: "synthetic-1:s1",
      dateTime: "10:00 am on 3 March, 2026",
      rounds: [
        {
          user: "Hi! I'm Dana Whitfield, I just joined the platform team as a database engineer.",
          assistant: "Welcome Dana! Great to have a database engineer on the platform team.",
        },
        {
          user: "My main project this quarter is migrating our metrics store from InfluxDB to ClickHouse. The deadline is June 15th.",
          assistant: "Noted — an InfluxDB to ClickHouse migration for the metrics store, due June 15th.",
        },
        {
          user: "By the way, I'm allergic to peanuts, so please keep that in mind if you ever suggest snacks for team events.",
          assistant: "Understood, I'll remember your peanut allergy for any food suggestions.",
        },
      ],
    },
    {
      sessionKey: "synthetic-1:s2",
      dateTime: "4:30 pm on 21 April, 2026",
      rounds: [
        {
          user: "Update: the ClickHouse migration deadline moved from June 15th to July 1st because the security review slipped.",
          assistant: "Got it — the migration deadline is now July 1st, pushed back by the security review.",
        },
        {
          user: "Also, I adopted a corgi last weekend! Her name is Biscuit.",
          assistant: "Congratulations on adopting Biscuit the corgi!",
        },
      ],
    },
  ];

  const questions: EvalQuestion[] = [
    {
      id: "syn-q1",
      question: "What is Dana's role and which team did she join?",
      goldAnswer: "Database engineer on the platform team",
      category: "single-hop",
    },
    {
      id: "syn-q2",
      question: "What is the current deadline of Dana's metrics store migration?",
      goldAnswer: "July 1st (moved from June 15th)",
      category: "temporal",
    },
    {
      id: "syn-q3",
      question: "Why should the assistant avoid suggesting peanut snacks to Dana, and what pet did she adopt?",
      goldAnswer: "She is allergic to peanuts, and she adopted a corgi named Biscuit",
      category: "multi-hop",
    },
    {
      id: "syn-q4",
      question: "What is the name of Dana's pet?",
      goldAnswer: "Biscuit",
      category: "single-hop",
    },
  ];

  return {
    name: "synthetic-smoke",
    source: "built-in",
    conversations: [{ conversationId: "synthetic-1", sessions, questions }],
  };
}

// ============================
// LoCoMo adapter
// ============================

interface LocomoTurn {
  speaker: string;
  dia_id?: string;
  text?: string;
  blip_caption?: string;
}

interface LocomoQa {
  question: string;
  answer?: unknown;
  adversarial_answer?: unknown;
  category: number;
  evidence?: string[];
}

interface LocomoSample {
  sample_id?: string;
  qa: LocomoQa[];
  conversation: Record<string, unknown> & { speaker_a?: string; speaker_b?: string };
}

export async function loadLocomoDataset(opts: {
  path?: string;
  url?: string;
  includeAdversarial?: boolean;
}): Promise<EvalDataset> {
  let raw: string;
  let source: string;
  if (opts.path) {
    raw = readFileSync(opts.path, "utf8");
    source = opts.path;
  } else {
    source = opts.url ?? LOCOMO_DEFAULT_URL;
    const res = await fetch(source);
    if (!res.ok) {
      throw new Error(`Failed to download LoCoMo dataset from ${source}: HTTP ${res.status}`);
    }
    raw = await res.text();
  }
  const samples = JSON.parse(raw) as LocomoSample[];
  if (!Array.isArray(samples)) {
    throw new Error("Unexpected LoCoMo format: top-level JSON array expected");
  }
  return {
    name: "locomo10",
    source,
    conversations: samples.map((s, i) => parseLocomoSample(s, i, opts.includeAdversarial ?? false)),
  };
}

export function parseLocomoSample(
  sample: LocomoSample,
  index: number,
  includeAdversarial: boolean,
): EvalConversation {
  const conversationId = String(sample.sample_id ?? `locomo-${index}`);
  const conv = sample.conversation ?? {};
  const speakerA = typeof conv.speaker_a === "string" ? conv.speaker_a : "SpeakerA";

  // Collect session_<n> keys in numeric order; each has a sibling
  // session_<n>_date_time carrying the in-universe date used by the
  // temporal questions.
  const sessionNums = Object.keys(conv)
    .map((k) => /^session_(\d+)$/.exec(k))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);

  const sessions: EvalSession[] = [];
  for (const n of sessionNums) {
    const turns = conv[`session_${n}`];
    if (!Array.isArray(turns) || turns.length === 0) continue;
    const dateTime = typeof conv[`session_${n}_date_time`] === "string"
      ? (conv[`session_${n}_date_time`] as string)
      : undefined;
    sessions.push({
      sessionKey: `${conversationId}:session_${n}`,
      dateTime,
      rounds: pairLocomoTurns(turns as LocomoTurn[], speakerA, dateTime),
    });
  }

  const questions: EvalQuestion[] = (sample.qa ?? [])
    .filter((qa) => includeAdversarial || qa.category !== 5)
    .map((qa, qi) => ({
      id: `${conversationId}:q${qi}`,
      question: qa.question,
      // Adversarial items carry the trap in `adversarial_answer`; the correct
      // behaviour is to say the information is not present.
      goldAnswer:
        qa.category === 5
          ? "The information is not mentioned in the conversation"
          : String(qa.answer ?? ""),
      category: LOCOMO_CATEGORY[qa.category] ?? "open-domain",
      evidence: qa.evidence,
    }));

  return { conversationId, sessions, questions };
}

/**
 * LoCoMo dialogs are two named humans, not user/assistant. We map
 * speaker_a → user and speaker_b → assistant, keep each line prefixed
 * with the real speaker name so extraction can attribute facts, merge
 * consecutive same-speaker lines, and anchor the session date on the
 * first round (the L0 capture timestamp is "now", so temporal questions
 * must be answerable from content alone).
 */
export function pairLocomoTurns(
  turns: LocomoTurn[],
  speakerA: string,
  dateTime: string | undefined,
): Array<{ user: string; assistant: string }> {
  const rounds: Array<{ user: string; assistant: string }> = [];
  let current: { user: string; assistant: string } | null = null;

  for (const t of turns) {
    const text = (t.text ?? "").trim();
    if (!text && !t.blip_caption) continue;
    const caption = t.blip_caption ? ` [shares an image: ${t.blip_caption}]` : "";
    const line = `${t.speaker}: ${text}${caption}`;
    const isUser = t.speaker === speakerA;

    if (isUser) {
      // A user line after the assistant already spoke closes the round.
      if (current && current.assistant) {
        rounds.push(current);
        current = null;
      }
      if (!current) current = { user: "", assistant: "" };
      current.user = current.user ? `${current.user}\n${line}` : line;
    } else {
      if (!current) current = { user: "", assistant: "" };
      current.assistant = current.assistant ? `${current.assistant}\n${line}` : line;
    }
  }
  if (current && (current.user || current.assistant)) rounds.push(current);

  // /capture requires both sides non-empty; fill structural gaps without
  // inventing content.
  for (const r of rounds) {
    if (!r.user) r.user = "(listens)";
    if (!r.assistant) r.assistant = "(listens)";
  }
  if (rounds.length > 0 && dateTime) {
    rounds[0].user = `[This conversation session takes place at ${dateTime}]\n${rounds[0].user}`;
  }
  return rounds;
}

// ============================
// Shared helpers
// ============================

/** Full raw transcript of a conversation — the no-memory baseline context. */
export function conversationTranscript(convo: EvalConversation, maxChars: number): string {
  const parts: string[] = [];
  for (const s of convo.sessions) {
    parts.push(`--- Session${s.dateTime ? ` (${s.dateTime})` : ""} ---`);
    for (const r of s.rounds) {
      parts.push(r.user, r.assistant);
    }
  }
  const full = parts.join("\n");
  // Keep the tail: later sessions override earlier facts more often than
  // the reverse, so truncating the head loses less.
  return full.length > maxChars ? full.slice(full.length - maxChars) : full;
}
