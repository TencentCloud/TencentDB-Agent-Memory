/**
 * Provenance of a memory record: where it came from and what touched it since
 * (ТЗ tz-05 A3 :66, A4a :68, A4b :71, A4c :74).
 *
 * The carrier is a reserved key inside the existing `metadata_json`, not a new
 * column and not a new table: `metadata_json` is already end-to-end through
 * `IMemoryStore` and lives on both backends, while a column would need a
 * migration on each and a table has no meaning on TCVDB at all.
 *
 * The key belongs to the core. A value arriving from model output, HTTP input
 * or an import is dropped — a record can describe its content, never its own
 * history. Everything here is pure: `now` is a parameter, so the collapse
 * boundary is testable without touching the clock.
 */

/** Reserved key inside `metadata_json`. Owned by the core (A4b). */
export const PROVENANCE_KEY = "_tdai_provenance";

/** How the record entered the system (A3 — closed set, anything else is refused). */
export type ProvenanceSource = "user-input" | "role-run" | "manual" | "import";

const SOURCES: readonly ProvenanceSource[] = [
  "user-input",
  "role-run",
  "manual",
  "import",
];

/** One touch: who, what, when. ~60-80 bytes, so 20 of them stay ~1.5 KB (A4c). */
export interface ProvenanceStep {
  role: string;
  action: string;
  at: string;
}

/**
 * The oldest steps, folded into a single entry that occupies one slot and
 * always comes first. Collapsing must be visible: "24 steps became 20" reads
 * as `collapsed: 5` plus 19 live ones, never as a silent loss of five.
 */
export interface ProvenanceCollapsed {
  collapsed: number;
  from: string;
  to: string;
}

export type ProvenanceEntry = ProvenanceCollapsed | ProvenanceStep;

export interface Provenance {
  source: ProvenanceSource;
  createdAt: string;
  chain: ProvenanceEntry[];
}

/**
 * Chain length. A working number, not a hard-won one: a record rewritten more
 * than twenty times by roles in a loop is itself worth looking at. Changing it
 * needs no migration — shorter chains stay valid.
 */
export const MAX_CHAIN = 20;

export function isCollapsed(
  entry: ProvenanceEntry,
): entry is ProvenanceCollapsed {
  return typeof (entry as ProvenanceCollapsed).collapsed === "number";
}

function isStep(value: unknown): value is ProvenanceStep {
  const step = value as ProvenanceStep;
  return (
    typeof step === "object" &&
    step !== null &&
    typeof step.role === "string" &&
    typeof step.action === "string" &&
    typeof step.at === "string"
  );
}

function isCollapsedEntry(value: unknown): value is ProvenanceCollapsed {
  const entry = value as ProvenanceCollapsed;
  return (
    typeof entry === "object" &&
    entry !== null &&
    typeof entry.collapsed === "number" &&
    Number.isFinite(entry.collapsed) &&
    typeof entry.from === "string" &&
    typeof entry.to === "string"
  );
}

/**
 * Read the chain off arbitrary metadata. Anything that is not a well-formed
 * provenance object — a string, `null`, someone else's JSON, a truncated
 * object — reads as `undefined`: an old record without provenance must keep
 * working, so a bad value is never an error.
 */
export function readProvenance(metadata: unknown): Provenance | undefined {
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const raw = (metadata as Record<string, unknown>)[PROVENANCE_KEY];
  if (typeof raw !== "object" || raw === null) return undefined;
  const candidate = raw as Partial<Provenance>;
  if (!SOURCES.includes(candidate.source as ProvenanceSource)) return undefined;
  if (typeof candidate.createdAt !== "string") return undefined;
  if (!Array.isArray(candidate.chain)) return undefined;
  const chain = candidate.chain.filter(
    (entry): entry is ProvenanceEntry =>
      isStep(entry) || isCollapsedEntry(entry),
  );
  return {
    source: candidate.source as ProvenanceSource,
    createdAt: candidate.createdAt,
    chain,
  };
}

function boundaryOf(entry: ProvenanceEntry): { from: string; to: string } {
  return isCollapsed(entry)
    ? { from: entry.from, to: entry.to }
    : { from: entry.at, to: entry.at };
}

function countOf(entry: ProvenanceEntry): number {
  return isCollapsed(entry) ? entry.collapsed : 1;
}

/**
 * Fold the head of an overlong chain into exactly one marker. A second marker
 * never appears: an existing one absorbs the newly folded steps, so the chain
 * reads as "N older steps, then the last 19".
 */
function collapseChain(chain: ProvenanceEntry[]): ProvenanceEntry[] {
  if (chain.length <= MAX_CHAIN) return chain;
  const head = chain.slice(0, chain.length - (MAX_CHAIN - 1));
  const tail = chain.slice(chain.length - (MAX_CHAIN - 1));
  const bounds = head.map(boundaryOf);
  const marker: ProvenanceCollapsed = {
    collapsed: head.reduce((total, entry) => total + countOf(entry), 0),
    from: bounds.reduce(
      (earliest, b) => (b.from < earliest ? b.from : earliest),
      bounds[0]!.from,
    ),
    to: bounds.reduce(
      (latest, b) => (b.to > latest ? b.to : latest),
      bounds[0]!.to,
    ),
  };
  return [marker, ...tail];
}

/**
 * Append one step. Without a previous chain this starts one, stamping the
 * creation time; with a previous chain the original `source` and `createdAt`
 * are kept — they describe the record's origin, and a later touch does not
 * rewrite where it came from.
 */
export function appendStep(
  previous: Provenance | undefined,
  step: ProvenanceStep,
  source: ProvenanceSource,
  now: string,
): Provenance {
  if (!previous) return { source, createdAt: now, chain: [step] };
  return {
    source: previous.source,
    createdAt: previous.createdAt,
    chain: collapseChain([...previous.chain, step]),
  };
}

/**
 * Drop any incoming provenance (A4b). Model output, HTTP input and imports all
 * arrive through the same `metadata` field, and none of them may claim a
 * server-side history.
 */
export function stripIncomingProvenance<T>(metadata: T): T {
  if (typeof metadata !== "object" || metadata === null) return metadata;
  if (!(PROVENANCE_KEY in (metadata as Record<string, unknown>)))
    return metadata;
  const { [PROVENANCE_KEY]: _dropped, ...rest } = metadata as Record<
    string,
    unknown
  >;
  return rest as T;
}

/**
 * The whole point of the package in one function: build the metadata that gets
 * written. Incoming metadata supplies content, the previous record supplies the
 * chain, and the step is added on top.
 *
 * `previous` is the metadata of the record being updated — for a fresh record
 * there is none, and the chain starts here.
 */
export function mergeMetadata(
  incoming: unknown,
  previous: unknown,
  step: ProvenanceStep,
  source: ProvenanceSource,
  now: string,
): Record<string, unknown> {
  const content = stripIncomingProvenance(
    typeof incoming === "object" && incoming !== null
      ? (incoming as Record<string, unknown>)
      : {},
  );
  return {
    ...content,
    [PROVENANCE_KEY]: appendStep(readProvenance(previous), step, source, now),
  };
}
