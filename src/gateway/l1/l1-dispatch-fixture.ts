import path from "node:path";
import type { RoleLegacyDefaults } from "../consolidation/role-contract-types.js";
import type {
  HostRunResult,
  LaunchInput,
  RoleLauncher,
} from "../consolidation/launchers/types.js";
import type { IMemoryStore } from "../../core/store/types.js";
import { GatewayL1AgentDispatcher } from "./l1-agent-dispatcher.js";

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const defaults: RoleLegacyDefaults = {
  failOpenPromptRoles: [],
  model: "test/model",
  thinking: "low",
  timeoutMs: 1_000,
  diffCap: 10,
  diffByteCap: 10_000,
  night: {
    diffCap: 10,
    diffByteCap: 10_000,
    deleteCapPerRun: 0,
    rewriteCapPerRun: 0,
    maxRunMs: 10_000,
  },
};

/** The record the near-duplicate recall lever plants in the store. */
export const NEAR_DUPLICATE_ID = "existing-dark-mode";

export function createTestL1Dispatcher(
  root: string,
  launcherOverride?: RoleLauncher,
): GatewayL1AgentDispatcher {
  const launcher = launcherOverride ?? storeOnlyLauncher();
  return new GatewayL1AgentDispatcher({
    dataDir: root,
    scratchRoot: path.join(root, "scratch"),
    roleDir: path.resolve("roles"),
    roleDefaults: defaults,
    launcherFor: () => launcher,
    logger,
    maxMemoriesPerSession: 20,
  });
}

/**
 * Make the parent's recall report an existing near-duplicate for whatever the
 * role proposes. This is the ONLY lever that fills `parentPolicyReasons`:
 * without a vector store the recall returns no matches and every candidate
 * passes the store policy.
 */
export function configureNearDuplicateRecall(
  dispatcher: GatewayL1AgentDispatcher,
): void {
  const row = {
    record_id: NEAR_DUPLICATE_ID,
    content: "The user prefers dark mode.",
    type: "persona",
    priority: 80,
    scene_name: "preference",
    score: 0.99,
    timestamp_str: "2026-08-14T00:00:00.000Z",
    timestamp_start: "",
    timestamp_end: "",
    session_key: "old",
    session_id: "old",
    metadata_json: "{}",
    project_id: "/repo",
    scope: "project",
  };
  const stored = {
    ...row,
    created_time: row.timestamp_str,
    updated_time: row.timestamp_str,
  };
  dispatcher.configureRecallContext({
    vectorStore: {
      isDegraded: () => false,
      getCapabilities: () => ({
        vectorSearch: true,
        ftsSearch: false,
        nativeHybridSearch: false,
        sparseVectors: false,
      }),
      searchL1Vector: async () => [row],
      getL1ById: async () => stored,
      queryL1Records: async () => [stored],
    } as unknown as IMemoryStore,
    embeddingService: {
      isReady: () => true,
      embed: async () => new Float32Array([1]),
    } as never,
  });
}

/** Always proposes a fresh `store`. Deliberately NOT retry-aware: a test that
 * expects a policy rejection must stay rejected on the second attempt too. */
function storeOnlyLauncher(): RoleLauncher {
  return stdoutLauncher((input) => candidateFor(input, null));
}

/** Repairs itself from the retry feedback the gateway hands back: the second
 * attempt updates the near-duplicate the parent recalled. The target id comes
 * from that feedback and never from a constant — `parseL1Candidate` only
 * accepts targets present in the same recall snapshot. */
export function retryAwareLauncher(): RoleLauncher {
  return stdoutLauncher((input) => {
    const { retry } = JSON.parse(input.taskPrompt) as {
      retry: { conflicts?: Array<{ nearDuplicateTargetId?: string }> } | null;
    };
    const target = retry?.conflicts?.find(
      ({ nearDuplicateTargetId }) => nearDuplicateTargetId,
    )?.nearDuplicateTargetId;
    return candidateFor(input, target ?? null);
  });
}

/** Emits a candidate that cannot pass the schema, so the attempt fails with
 * `invalid-candidate` — the fail-closed lever that survives the critic's
 * removal. */
export function invalidOutputLauncher(): RoleLauncher {
  return stdoutLauncher(() => ({ version: 1, scenes: "not-an-array" }));
}

function stdoutLauncher(
  outputFor: (input: LaunchInput) => unknown,
): RoleLauncher {
  return {
    id: "pi",
    capabilities: new Set(["session", "thinking", "tool-subset"]),
    async launch(input: LaunchInput) {
      const result: HostRunResult = {
        status: "succeeded",
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify(outputFor(input)),
        stderr: "",
      };
      return {
        ok: true as const,
        handle: {
          sessionRef: `fake:${input.attemptId}`,
          completion: Promise.resolve(result),
          cancelAndWait: () => Promise.resolve(result),
        },
      };
    },
  };
}

function candidateFor(input: LaunchInput, targetId: string | null) {
  const parsed = JSON.parse(input.taskPrompt) as Record<string, unknown>;
  const workset = (parsed.workset ?? parsed) as {
    assignmentId: string;
    inputDigest: string;
    projectId: string;
    messages: Array<{ id: string }>;
  };
  const sourceId = workset.messages[0]!.id;
  return {
    version: 1,
    assignmentId: workset.assignmentId,
    inputDigest: workset.inputDigest,
    scenes: [
      {
        name: "preference",
        messageIds: [sourceId],
        memories: [
          {
            candidateId: "dark-mode",
            content: "The user prefers dark mode.",
            type: "persona",
            scope: workset.projectId ? "project" : "global",
            priority: 80,
            sourceMessageIds: [sourceId],
            metadata: {},
            action: targetId ? "update" : "store",
            targetIds: targetId ? [targetId] : [],
          },
        ],
      },
    ],
  };
}
