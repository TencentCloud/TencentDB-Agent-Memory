import { digestL1Artifact } from "../../core/record/l1-agent-codec.js";
import type {
  L1ConflictCandidate,
  L1ConflictCandidateRepository,
} from "../../core/record/l1-conflict-candidates.js";
import { L1_NEAR_DUP_SCORE } from "../../core/record/l1-conflict-candidates.js";
import type { L1CandidateMemoryV1 } from "../../core/record/l1-agent-types.js";
import type { EmbeddingService } from "../../core/store/embedding.js";
import { buildFtsQuery } from "../../core/store/sqlite.js";
import type {
  IMemoryStore,
  L1FtsResult,
  L1SearchResult,
} from "../../core/store/types.js";
import type { Logger } from "../../core/types.js";

const TOP_K = 5;

export class StoreL1ConflictCandidates
  implements L1ConflictCandidateRepository
{
  constructor(
    private readonly store: () => IMemoryStore | undefined,
    private readonly embedding: () => EmbeddingService | undefined,
    private readonly logger: Logger,
  ) {}

  async recall(candidate: L1CandidateMemoryV1, projectId: string) {
    const store = this.store();
    if (!store || store.isDegraded())
      return { candidateId: candidate.candidateId, matches: [] };
    const matches = new Map<string, L1ConflictCandidate>();
    const capabilities = store.getCapabilities();
    if (capabilities.vectorSearch && this.embedding()?.isReady()) {
      try {
        const vector = await this.embedding()!.embed(candidate.content, {
          inputType: "query",
        });
        const rows = await store.searchL1Vector(
          vector,
          TOP_K,
          candidate.content,
          projectId,
        );
        this.addRows(matches, rows, candidate, projectId, "vector");
      } catch (error) {
        this.logger.warn?.(
          `[l1-conflicts] vector recall failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (capabilities.ftsSearch && matches.size < TOP_K) {
      const query = buildFtsQuery(candidate.content);
      if (query) {
        const rows = await store.searchL1Fts(query, TOP_K, projectId);
        this.addRows(matches, rows, candidate, projectId, "fts");
      }
    }
    const pinned = await this.pinRows(store, [...matches.values()]);
    const nearDuplicateTargetId = pinned.find(
      (match) =>
        match.source === "vector" &&
        match.score >= L1_NEAR_DUP_SCORE &&
        match.type === candidate.type,
    )?.id;
    return {
      candidateId: candidate.candidateId,
      matches: pinned.slice(0, TOP_K),
      ...(nearDuplicateTargetId ? { nearDuplicateTargetId } : {}),
    };
  }

  private async pinRows(
    store: IMemoryStore,
    matches: L1ConflictCandidate[],
  ): Promise<L1ConflictCandidate[]> {
    if (matches.length === 0) return [];
    const pinned: L1ConflictCandidate[] = [];
    for (const match of matches) {
      // getL1ById throws when the backend cannot establish presence. Never
      // turn an unreadable store into "no conflicts" and permit a duplicate.
      const row = await store.getL1ById(match.id);
      if (!row) continue;
      pinned.push({
        ...match,
        content: row.content,
        contentDigest: digestL1Artifact(row.content),
        scope: row.scope ?? (row.project_id ? "project" : "global"),
        projectId: row.project_id ?? "",
        updatedAt: row.updated_time,
      });
    }
    return pinned;
  }

  private addRows(
    target: Map<string, L1ConflictCandidate>,
    rows: Array<L1SearchResult | L1FtsResult>,
    candidate: L1CandidateMemoryV1,
    projectId: string,
    source: "vector" | "fts",
  ): void {
    for (const row of rows) {
      if (target.size >= TOP_K) return;
      if (!sameScope(row, candidate, projectId) || target.has(row.record_id))
        continue;
      target.set(row.record_id, {
        id: row.record_id,
        content: row.content,
        contentDigest: digestL1Artifact(row.content),
        type: row.type,
        scope: row.scope ?? "global",
        projectId: row.project_id ?? "",
        score: row.score,
        source,
        timestamp: row.timestamp_str,
        updatedAt: "",
        metadata: parseMetadata(row.metadata_json),
      });
    }
  }
}

function sameScope(
  row: L1SearchResult | L1FtsResult,
  candidate: L1CandidateMemoryV1,
  projectId: string,
): boolean {
  const scope = row.scope ?? (row.project_id ? "project" : "global");
  return candidate.scope === "global"
    ? scope === "global"
    : scope === "project" && (row.project_id ?? "") === projectId;
}

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
