/**
 * Context assembly contracts (tz-10 §Контракты).
 *
 * The assembler is a domain of its own, not part of search: search answers
 * "what is relevant", assembly answers "what fits and why". Keeping the two
 * apart is what lets the assembler stay pure — it never learns where an item
 * came from.
 */

/** Single source of truth for a memory that can be formatted for the LLM. */
export interface FormatableMemory {
  type: string;
  content: string;
  scene_name?: string;
  /** Activity time range start (段时间 start), may be empty */
  activity_start_time?: string;
  /** Activity time range end (段时间 end), may be empty */
  activity_end_time?: string;
  /** Activity point-in-time (点时间: when it happened), may be empty */
  timestamp?: string;
}

/**
 * Version of the `RecallItem` projection (tz-10 C10.7). Bumped when the shape
 * or the meaning of `provenance.status` changes, so a consumer can tell a
 * pre-tz-05 projection from native scope/provenance data.
 */
export const RECALL_ITEM_SCHEMA_VERSION = 1;

/**
 * Structured recall element — what the strategies actually found, before it is
 * rendered for the prompt (tz-10 C10.3). The rendered line is a projection of
 * `formatable`, never the other way round: parsing a line back into fields is
 * what lost ids and scores before tz-10a.
 *
 * tz-10b's `MemoryItem` = `RecallItem & { tokenCost: number }` — the budget and
 * the tokenizer belong to the assembler, not to the search path.
 */
export interface RecallItem {
  schemaVersion: typeof RECALL_ITEM_SCHEMA_VERSION;
  /** Store record id. Empty only when the backend does not expose one. */
  memoryId: string;
  kind: "l1";
  content: string;
  /** Everything the renderer needs — single source of the injected line. */
  formatable: FormatableMemory;
  scope: {
    /** null until tz-05 gives records a real owner (C10.7). */
    userId: string | null;
    /** Project the record is tagged to; "" / undefined = untagged. */
    projectId?: string;
    /** 'global' | 'project' | undefined (legacy rows predate scoping). */
    scope?: string;
    sessionKey?: string;
    sessionId?: string;
  };
  provenance: {
    /** L0 messages behind the record; [] until tz-05 (C10.7). */
    sourceIds: string[];
    producer: string;
    createdAt: string;
    updatedAt: string;
    /** "unknown" = projected without native provenance (pre-tz-05). */
    status: "native" | "projected" | "unknown";
  };
  /** `raw` = score as the store returned it; `final` = after every multiplier. */
  score: { raw: number; final: number; reasons: string[] };
}

/** Where a recall diagnostic came from (tz-10 C10.5). */
export type RecallDiagnosticStage =
  "repo" | "scope" | "strategy" | "tokenize" | "dedup" | "budget" | "render";

/**
 * One machine-readable note about the recall path. A failure that produces a
 * diagnostic is NOT the same as "no memories" — that conflation is exactly what
 * tz-10 C10.5 forbids.
 */
export interface RecallDiagnostic {
  stage: RecallDiagnosticStage;
  code: string;
  message: string;
  itemId?: string;
}

/**
 * One element that can enter the context, with what it costs to include it.
 *
 * `RecallItem.kind` stays `"l1"` — search returns L1 and nothing else. The
 * assembler widens the kind for the elements the shell adds around a search
 * result (persona, scene navigation).
 *
 * `formatable` is inherited from `RecallItem` and stays honest for the new
 * kinds: it carries the element's own text with a type of `"persona"` /
 * `"scene-nav"`. It is NOT a line of the L1 list — persona and scene render
 * through their own wrappers, and `formatMemoryLine` is never called on them.
 */
export type MemoryItem = Omit<RecallItem, "kind"> & {
  kind: "l1" | "persona" | "scene";
  /** What including this element costs, in the envelope's tokenizer's units. */
  tokenCost: number;
};

/** Counts tokens the same way every time; injected so the domain stays pure. */
export interface Tokenizer {
  id: string;
  version: string;
  count: (text: string) => number;
}

/**
 * One rendered block plus the items behind it. The assembler concatenates
 * segments into `renderedContext`; the shell distributes them into the two
 * fields the caller already knows. Neither side ever splits a rendered string
 * back into parts — that reverse parse is what tz-10 C10.2 forbids.
 */
export interface ContextSegment {
  /** Which half of the injected context this block belongs to. */
  slot: "prepend" | "append";
  /** Items this block was rendered from; empty = static prompt scaffolding. */
  itemIds: string[];
  text: string;
}

/**
 * Renders the included items into blocks, in the order they will be injected.
 *
 * Contract for a caller that splits the envelope back into two fields: emit
 * every `prepend` block before any `append` one. Only then does joining the two
 * slots reproduce `renderedContext` byte for byte.
 */
export type ContextRenderer = (included: MemoryItem[]) => ContextSegment[];

/**
 * How the assembler decides. Only what tz-10b actually applies: the hard scope
 * gate for another session, the foreign-project decay, the conflict policy and
 * fail-closed ownership belong to packages that own that data (session
 * isolation, tz-04, tz-05) and are NOT claimed here.
 */
export interface ContextAssemblerPolicy {
  /** Inclusion priority by kind — tz-10:103 order, not the render order. */
  precedence: MemoryItem["kind"][];
  /** `exact` = identical content is dropped; semantic dedup needs embeddings. */
  dedup: "exact" | "off";
}

/** Everything the assembly did, in one auditable object (tz-10:74-97). */
export interface ContextEnvelope {
  schemaVersion: 1;
  requestId: string;
  sessionKey: string;
  sessionId: string;
  projectId?: string;
  budget: {
    total: number;
    /** Tokens the rendered context actually costs, recounted on the full text. */
    used: number;
    reservedForUser: number;
    tokenizerId: string;
    tokenizerVersion: string;
    /** `used` minus the sum of included item costs: wrappers and separators. */
    renderOverhead: number;
  };
  included: MemoryItem[];
  excluded: Array<{ item: MemoryItem; reason: string }>;
  diagnostics: RecallDiagnostic[];
  /**
   * The blocks `renderedContext` was concatenated from, each naming the items
   * behind it. This is the mechanism behind the `context-envelope-complete`
   * invariant: a consumer traces a fragment to its item by reading this list,
   * never by parsing the rendered string back apart.
   */
  segments: ContextSegment[];
  /** Exactly the string the caller will inject — nothing is added later. */
  renderedContext: string;
}
