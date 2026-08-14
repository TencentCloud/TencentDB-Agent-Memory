import { createHash } from "node:crypto";
import { z } from "zod";
import { L1AgentValidationError } from "./l1-agent-errors.js";
import type {
  L1CandidateV1,
  L1WorksetV1,
  L1WorksetMessageV1,
  L1CursorV1,
} from "./l1-agent-types.js";

const MAX_CONTENT_CHARS = 600;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

const cursorSchema = z.strictObject({
  recordedAtMs: z.number().int().nonnegative(),
  recordId: z.string().min(1),
});

const messageSchema = z.strictObject({
  id: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1),
  timestamp: z.string().min(1),
});

const memorySchema = z.strictObject({
  candidateId: z.string().min(1),
  content: z.string().min(1).max(MAX_CONTENT_CHARS),
  type: z.enum(["persona", "episodic", "instruction"]),
  scope: z.enum(["global", "project"]),
  priority: z.number().int().min(-1).max(100),
  sourceMessageIds: z.array(z.string().min(1)),
  metadata: z.record(z.string(), z.unknown()),
  action: z.enum(["store", "update", "merge", "skip"]),
  targetIds: z.array(z.string().min(1)),
});

const sceneSchema = z.strictObject({
  name: z.string().min(1),
  messageIds: z.array(z.string().min(1)),
  memories: z.array(memorySchema),
});

const candidateSchema = z.strictObject({
  version: z.literal(1),
  assignmentId: z.string().min(1),
  inputDigest: z.string().regex(DIGEST_PATTERN),
  scenes: z.array(sceneSchema),
});

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

export function digestL1Artifact(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

export function deriveL1AssignmentId(input: {
  sessionKey: string;
  sessionId: string;
  projectId: string;
  cursorStart: L1CursorV1;
  cursorEnd: L1CursorV1;
  messages: L1WorksetMessageV1[];
}): string {
  return `l1a_${digestL1Artifact({ version: 1, ...input })}`;
}

export function deriveL1RecordId(
  assignmentId: string,
  candidateId: string,
): string {
  return `m_l1_${digestL1Artifact({ assignmentId, candidateId }).slice(0, 32)}`;
}

export function parseL1Candidate(
  raw: unknown,
  workset: L1WorksetV1,
  allowedTargetIds: ReadonlySet<string> = new Set(),
): L1CandidateV1 {
  const parsed = candidateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new L1AgentValidationError(z.prettifyError(parsed.error));
  }
  validateCandidateReferences(parsed.data, workset, allowedTargetIds);
  return parsed.data;
}

function validateCandidateReferences(
  candidate: L1CandidateV1,
  workset: L1WorksetV1,
  allowedTargetIds: ReadonlySet<string>,
): void {
  if (candidate.assignmentId !== workset.assignmentId)
    throw new L1AgentValidationError("candidate assignmentId mismatch");
  if (candidate.inputDigest !== workset.inputDigest)
    throw new L1AgentValidationError("candidate inputDigest mismatch");
  const sourceIds = new Set(workset.messages.map((message) => message.id));
  const candidateIds = new Set<string>();
  for (const scene of candidate.scenes) {
    for (const id of scene.messageIds)
      if (!sourceIds.has(id))
        throw new L1AgentValidationError(`unknown message id: ${id}`);
    for (const memory of scene.memories) {
      if (candidateIds.has(memory.candidateId))
        throw new L1AgentValidationError(
          `duplicate candidate id: ${memory.candidateId}`,
        );
      candidateIds.add(memory.candidateId);
      for (const id of memory.sourceMessageIds)
        if (!sourceIds.has(id))
          throw new L1AgentValidationError(`unknown source id: ${id}`);
      for (const id of memory.targetIds)
        if (!allowedTargetIds.has(id))
          throw new L1AgentValidationError(`unknown target id: ${id}`);
      if (memory.scope === "project" && workset.projectId === "")
        throw new L1AgentValidationError("project memory requires projectId");
    }
  }
}
