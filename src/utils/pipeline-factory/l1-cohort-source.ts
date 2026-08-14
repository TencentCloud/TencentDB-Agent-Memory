import { readConversationMessagesGroupedBySessionId } from "../../core/conversation/l0-recorder.js";
import type { L1ExtractionDispatcher } from "../../core/record/l1-agent-types.js";
import type { IMemoryStore, L0SessionGroup } from "../../core/store/types.js";
import { persistL1Cohort } from "../../gateway/l1/l1-cohort-builder.js";
import { readOldestOpenL1Cohort } from "../../gateway/l1/l1-cohort-repo.js";
import type { L1CohortRow } from "../../gateway/l1/l1-control-types.js";
import type { RunnerSessionState } from "../checkpoint.js";
import type { PipelineLogger } from "./types.js";

const PAGE_SIZE = 50;

export async function ensureOpenL1Cohort(input: {
  dataDir: string;
  sessionKey: string;
  role: string;
  state: RunnerSessionState;
  dispatcher: L1ExtractionDispatcher;
  vectorStore?: IMemoryStore;
  logger: PipelineLogger;
}): Promise<L1CohortRow | null> {
  const open = readOldestOpenL1Cohort(input.dataDir, input.sessionKey);
  if (open) return open;
  const groups = await readGroups(input);
  if (groups.length === 0) return null;
  persistL1Cohort({
    dataDir: input.dataDir,
    sessionKey: input.sessionKey,
    cursorStart: {
      recordedAtMs: input.state.last_l1_cursor,
      recordId: input.state.last_l1_cursor_id,
    },
    groups,
    roleContractHash: input.dispatcher.resolveRoleContractHash(input.role),
    previousSceneName: input.state.last_scene_name || undefined,
    nowIso: new Date().toISOString(),
  });
  return readOldestOpenL1Cohort(input.dataDir, input.sessionKey);
}

async function readGroups(input: {
  dataDir: string;
  sessionKey: string;
  state: RunnerSessionState;
  vectorStore?: IMemoryStore;
  logger: PipelineLogger;
}): Promise<L0SessionGroup[]> {
  const after = input.state.last_l1_cursor || undefined;
  const afterId = input.state.last_l1_cursor_id || undefined;
  if (input.vectorStore && !input.vectorStore.isDegraded()) {
    return input.vectorStore.queryL0GroupedBySessionId(
      input.sessionKey,
      after,
      PAGE_SIZE,
      afterId,
    );
  }
  const groups = await readConversationMessagesGroupedBySessionId(
    input.sessionKey,
    input.dataDir,
    after,
    input.logger,
    PAGE_SIZE,
    afterId,
  );
  return groups.map((group) => ({
    sessionId: group.sessionId,
    projectId: group.projectId,
    messages: group.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      recordedAtMs: message.recordedAtMs,
    })),
  }));
}
