import path from "node:path";
import type { RoleLegacyDefaults } from "../consolidation/role-contract-types.js";
import type {
  HostRunResult,
  LaunchInput,
  RoleLauncher,
} from "../consolidation/launchers/types.js";
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

export function createTestL1Dispatcher(
  root: string,
  criticVerdict: "approve" | "reject" | readonly ("approve" | "reject")[],
  launcherOverride?: RoleLauncher,
): GatewayL1AgentDispatcher {
  const launcher = launcherOverride ?? fakeLauncher(criticVerdict);
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

function fakeLauncher(
  configured: "approve" | "reject" | readonly ("approve" | "reject")[],
): RoleLauncher {
  let criticCalls = 0;
  return {
    id: "pi",
    capabilities: new Set(["session", "thinking", "tool-subset"]),
    async launch(input: LaunchInput) {
      const result: HostRunResult = {
        status: "succeeded",
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify(
          outputFor(
            input,
            Array.isArray(configured)
              ? input.contract.role.endsWith("critic")
                ? configured[Math.min(criticCalls++, configured.length - 1)]!
                : configured[0]!
              : configured,
          ),
        ),
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

function outputFor(input: LaunchInput, verdict: "approve" | "reject") {
  const parsed = JSON.parse(input.taskPrompt) as Record<string, unknown>;
  if (input.contract.role.endsWith("critic")) {
    return {
      verdict,
      candidateDigest: parsed.candidateDigest,
      inputDigest: parsed.inputDigest,
      reasons: verdict === "approve" ? [] : ["not durable"],
    };
  }
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
            action: "store",
            targetIds: [],
          },
        ],
      },
    ],
  };
}
