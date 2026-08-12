/**
 * Context assembly contracts (tz-10 §Контракты).
 *
 * The assembler is a domain of its own, not part of search: search answers
 * "what is relevant", assembly answers "what fits and why". Keeping the two
 * apart is what lets the assembler stay pure — it never learns where an item
 * came from.
 */

import type {
  RecallDiagnostic,
  RecallItem,
} from "../hooks/auto-recall/types.js";

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

/** Renders the included items into blocks, in the order they will be injected. */
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
  /** Tokens held back for the user's own prompt; never spent on memory. */
  reservedForUser: number;
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
