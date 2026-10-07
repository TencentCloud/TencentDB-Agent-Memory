import { createHash } from "node:crypto";
import type { IMemoryStore, L1RecordRow, MemoryEvent } from "./types.js";
import { clearFilter, confirmReviewCommit, historicalReviewRows, queryReviewHistory, resolveReviewFacts, ReviewCapabilityError, ReviewConflictError, reviewEventId, tokenOf } from "./review.js";

type ProfileScope = { teamId?: string; userId?: string; agentId?: string };
type Operation = { operation_id: string; request_id?: string; reviewer_id?: string; reason: string };
const hashOf = (value: string) => createHash("sha256").update(value).digest("hex");
const fenceHash = (fence: readonly string[]) => hashOf(JSON.stringify([...fence].sort()));
const rowKey = (r: L1RecordRow) => JSON.stringify([r.team_id || "default", r.user_id || "default", r.agent_id || "default", r.record_id]);

export const isDerivedReviewPath = (path: string): boolean => path === "persona.md" || path === ".metadata/scene_index.json" || (path.startsWith("scene_blocks/") && path.endsWith(".md") && !path.split("/").includes(".."));

export async function profileReviewFence(store: IMemoryStore, isolation?: ProfileScope): Promise<string[]> {
  if (!store.queryMemoryEvents) throw new Error("Review ledger unavailable");
  const scope: { team_id?: string; agent_id?: string; user_id?: string } = isolation ? { team_id: isolation.teamId || "default", agent_id: isolation.agentId || "default", ...(isolation.teamId ? {} : { user_id: isolation.userId || "default" }) } : {};
  const events = await queryReviewHistory(store, { ...scope, layer: "l1", source: "review", metadata_only: true });
  const current = await store.queryL1Records({ teamId: scope.team_id, userId: scope.user_id, agentId: scope.agent_id, visibility: "quarantined" }, { review: false, metadataOnly: true });
  const roots = new Map(historicalReviewRows(events).map((r) => [rowKey(r), r]));
  for (const row of current) roots.set(rowKey(row), { ...row, review_sources_json: "[]" });
  const tokens = new Set(resolveReviewFacts([...roots.values()], events).flatMap((r) => r.review_tokens ?? []));
  for (const event of events) if (event.op === "reverted") tokens.add(`revert:${tokenOf(event)}`);
  const clear = (await store.queryMemoryEvents(clearFilter({ team_id: scope.team_id, agent_id: scope.agent_id })))[0];
  if (clear) tokens.add(`clear:${tokenOf(clear)}`);
  return [...tokens].sort();
}

export async function derivedProfileAllowed(store: IMemoryStore, path: string, content: string, fence: readonly string[], isolation?: ProfileScope): Promise<boolean> {
  if (!fence.length) return true;
  const events = await queryReviewHistory(store, { record_id: path, layer: path === "persona.md" ? "l3" : "l2", source: "review", op: "updated", team_id: isolation?.teamId || "default", agent_id: isolation?.agentId || "default", metadata_only: true });
  const contentHash = hashOf(content);
  const currentFence = fenceHash(fence);
  return events.some((event) => event.review?.content_hash === contentHash && event.review.fence_hash === currentFence);
}

export async function inspectDerivedReview(store: IMemoryStore, path: string, content: string, isolation: ProfileScope) {
  if (!isDerivedReviewPath(path)) throw new ReviewConflictError("Unsupported derived artifact path");
  const fence = await profileReviewFence(store, isolation);
  return { content_hash: hashOf(content), fence_hash: fenceHash(fence), blocked: !(await derivedProfileAllowed(store, path, content, fence, isolation)) };
}

export async function acknowledgeDerivedReview(store: IMemoryStore, path: string, content: string, expected: { content_hash: string; fence_hash: string }, isolation: ProfileScope, operation: Operation): Promise<MemoryEvent> {
  if (!store.queryMemoryEvents || !store.commitMemoryEvent) throw new ReviewCapabilityError("Derived acknowledgement requires an atomic immutable ledger");
  if (!isolation.teamId || !isolation.agentId || !isDerivedReviewPath(path)) throw new ReviewConflictError("Explicit derived review scope and path required");
  const identity = `rop-${hashOf(JSON.stringify(["derived", isolation.teamId, isolation.agentId, path, operation.operation_id]))}`;
  const requestHash = hashOf(JSON.stringify([expected.content_hash, expected.fence_hash, operation.reason, operation.reviewer_id ?? ""]));
  const prior = await store.queryMemoryEvents({ record_id: path, layer: path === "persona.md" ? "l3" : "l2", source: "review", team_id: isolation.teamId, agent_id: isolation.agentId, operation_id: identity, limit: 2 });
  if (prior.length > 1) throw new ReviewConflictError("Duplicate derived receipts violate immutable identity");
  if (prior[0]) {
    if (!prior[0].review?.operation_id) throw new Error("Derived receipt identity required");
    if (prior[0].review.request_hash !== requestHash) throw new ReviewConflictError("Derived review operation identity reused with different input");
    return prior[0];
  }
  if (hashOf(content) !== expected.content_hash) throw new ReviewConflictError("Derived artifact changed; review the current content");
  if (fenceHash(await profileReviewFence(store, isolation)) !== expected.fence_hash) throw new ReviewConflictError("Review fence changed; review the current artifact again");
  const event: MemoryEvent = {
    event_ts: new Date().toISOString(), session_id: "", session_key: "",
    team_id: isolation.teamId, user_id: "default", agent_id: isolation.agentId, record_id: path, layer: path === "persona.md" ? "l3" : "l2",
    op: "updated", source: "review", content: "", reason: operation.reason, reviewer_id: operation.reviewer_id, request_id: operation.request_id,
    review: { protocol: 2, operation_id: identity, request_hash: requestHash, content_hash: expected.content_hash, fence_hash: expected.fence_hash, guard_epoch: store.getClearEpoch ? await store.getClearEpoch(isolation) : undefined },
  };
  event.event_id = reviewEventId(event);
  return confirmReviewCommit(event, await store.commitMemoryEvent(event));
}
