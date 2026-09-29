/**
 * Regression tests for Issue #1239 Bug 2:
 *
 *   "[WorkBuddy] Session Init 三处缺陷导致无法完成团队资产绑定与 L0 写入"
 *
 * Bug 2: when a team carries exactly ONE agent, the split-stage clients
 * (workbuddy / codex / dsh / opencode) still enter `pending_agent_select` and
 * render an agent form. `workbuddy/form.ts` requires >= 2 options per page
 * (AskUserQuestion hard constraint) and THROWS on a solo option:
 *
 *   [wb form] agent page 0 has 1 option(s);
 *   pagination.ts should have avoided a solo last page.
 *
 * The exception escapes `handleSessionInit`, so the session never reaches
 * `initialized` — `hasSessionInfo=false`, the injection pipeline is skipped
 * and `tdai-recorder:write-l0` stays 0 forever.
 *
 * `claude-code/init.ts` already implements the right semantics via
 * `advanceFromTeamPicked` / `advanceFromAgentPicked`:
 *   - 0 agents  → bypass
 *   - 1 agent   → auto-select, then 0 tasks → bypass / 1 task → complete / >=2 → task form
 *   - >=2 agents → agent form
 *
 * The codebuddy state machine (which the split-stage clients reuse) lacks the
 * `agents.length === 1` branch in its `pending_team_select` handler.
 */

import { describe, expect, it } from "vitest";
import { handleSessionInit } from "../init.js";
import { SessionStore } from "../../store.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

interface FakeAgent {
  agent_id: string;
  name: string;
  description?: string;
}
interface FakeTask {
  task_id: string;
  title: string;
}

function makeMetadataClient(opts: {
  agents: FakeAgent[];
  tasks: FakeTask[];
}) {
  const calls = { listTeams: 0, listAgents: 0, listTasks: 0 };
  return {
    calls,
    async listTeams(_userId: string) {
      calls.listTeams++;
      return [
        {
          team_id: "team-aaaa-bbbb",
          name: "global-dev",
          description: "dev team",
        },
      ];
    },
    async listAgents(_teamId: string, _ownerUserId?: string) {
      calls.listAgents++;
      return opts.agents;
    },
    async listTasks(_teamId: string) {
      calls.listTasks++;
      return opts.tasks;
    },
    // completeRegistration() fans these out via Promise.allSettled — a missing
    // method surfaces as "getAgent is not a function", which is a fixture gap
    // rather than the bug under test.
    async getAgent(agentId: string) {
      const a = opts.agents.find((x) => x.agent_id === agentId);
      return {
        agent_id: agentId,
        name: a?.name ?? "unknown-agent",
        description: a?.description ?? "",
        prompt: "",
      };
    },
    async getTask(taskId: string) {
      const t = opts.tasks.find((x) => x.task_id === taskId);
      return {
        task_id: taskId,
        title: t?.title ?? "unknown-task",
        description: "",
      };
    },
    async appendParticipationLog(_entry: unknown) {
      return undefined;
    },
  };
}

function makeConfig() {
  return {
    enabled: true,
    maxRetries: 3,
    // NOTE: `skipAssetConfirm` is referenced by codebuddy/init.ts but missing
    // from SessionInitConfig in src/types.ts (pre-existing upstream tsc error,
    // see src/config.ts:425). Cast keeps this test focused on runtime behavior.
    skipAssetConfirm: false,
  } as unknown as Parameters<typeof handleSessionInit>[3];
}

function makeReqCtx() {
  // Param 6 (1-based) = index 5 in the 0-based tuple = `reqCtx`.
  return { stream: false } as unknown as Parameters<typeof handleSessionInit>[5];
}

/** One user message answering the team form with the team's display label. */
function teamAnswerMessages(): Record<string, unknown>[] {
  return [{ role: "user", content: "global-dev (aaaa-bbbb)" }];
}

/**
 * Seed `pending_team_select` state so the next request is treated as the answer.
 *
 * `cachedTeams` MUST mirror what `makeMetadataClient` returns — the state
 * machine resolves the picked team from `state.cachedTeams` (not from a fresh
 * fetch), so a mismatch makes the test assert against stale fixtures.
 */
async function seedPendingTeamSelect(
  store: SessionStore,
  compositeKey: string,
  sessionKey: string,
  opts: { agents: FakeAgent[]; tasks: FakeTask[] },
) {
  await store.set(compositeKey, {
    status: "pending_team_select",
    keyId: sessionKey,
    startedAt: Date.now(),
    attemptCount: 0,
    userId: "u-1",
    cachedTeams: [
      {
        team_id: "team-aaaa-bbbb",
        team_name: "global-dev",
        agents: opts.agents.map((a) => ({
          agent_id: a.agent_id,
          agent_name: a.name,
          description: a.description ?? "",
        })),
        tasks: opts.tasks.map((t) => ({
          task_id: t.task_id,
          task_name: t.title,
        })),
      },
    ],
  } as unknown as Parameters<SessionStore["set"]>[1]);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

/**
 * Wire up a session parked at `pending_team_select` plus a metadata client
 * that reports the same agents/tasks. Both must agree: the state machine
 * resolves the picked team from `state.cachedTeams`, so a fixture mismatch
 * would make the assertions test stale data instead of the fix.
 */
function setup(opts: { agents: FakeAgent[]; tasks: FakeTask[] }) {
  const store = new SessionStore();
  return { store, meta: makeMetadataClient(opts), opts };
}

async function runTeamAnswer(
  s: ReturnType<typeof setup>,
  agentSource = "workbuddy",
) {
  const COMPOSITE = `${agentSource}:sess-1234`;
  await seedPendingTeamSelect(s.store, COMPOSITE, "sess-1234", s.opts);
  // Param 7 (1-based) = index 6 in the 0-based tuple = `metadataClient`.
  // It is optional in the signature, so the extracted tuple member is
  // `MetadataClient | undefined` — non-null it for the call.
  const meta = s.meta as unknown as NonNullable<Parameters<typeof handleSessionInit>[6]>;
  return handleSessionInit(
    "sess-1234",
    "u-1",
    teamAnswerMessages(),
    makeConfig(),
    s.store,
    makeReqCtx(),
    meta,
    undefined,
    undefined,
    undefined,
    agentSource,
  );
}

const SOLO_AGENT: FakeAgent[] = [
  { agent_id: "agent-solo-01", name: "workbuddy-builder", description: "" },
];
const TWO_AGENTS: FakeAgent[] = [
  { agent_id: "agent-01", name: "builder", description: "" },
  { agent_id: "agent-02", name: "reviewer", description: "" },
];
const ONE_TASK: FakeTask[] = [{ task_id: "task-daily", title: "日常开发" }];
const TWO_TASKS: FakeTask[] = [
  { task_id: "task-a", title: "任务A" },
  { task_id: "task-b", title: "任务B" },
];

describe("Issue #1239 Bug 2 — solo-agent team must not render an agent form", () => {
  it("auto-selects the sole agent and completes registration (1 task)", async () => {
    const s = setup({ agents: SOLO_AGENT, tasks: ONE_TASK });
    const result = await runTeamAnswer(s);

    const state = s.store.get("workbuddy:sess-1234");
    expect(state?.status).toBe("initialized");
    expect(state?.bypassed).not.toBe(true);
    expect(state?.sessionInfo).not.toBeNull();
    expect(result.intercepted).toBe(false);
  });

  it("bypasses when the sole agent's team has 0 tasks", async () => {
    const s = setup({ agents: SOLO_AGENT, tasks: [] });
    const result = await runTeamAnswer(s);

    const state = s.store.get("workbuddy:sess-1234");
    expect(state?.status).toBe("initialized");
    expect(state?.bypassed).toBe(true);
    expect(result.bypassed).toBe(true);
  });

  it("enters task_select (not agent_select) when the sole agent has >= 2 tasks", async () => {
    const s = setup({ agents: SOLO_AGENT, tasks: TWO_TASKS });
    const result = await runTeamAnswer(s);

    const state = s.store.get("workbuddy:sess-1234");
    expect(state?.status).toBe("pending_task_select");
    expect(state?.selectedAgentId).toBe("agent-solo-01");
    expect(result.intercepted).toBe(true);
    expect(result.formData?.stage).toBe("task_select");
  });

  it("bypasses when the picked team has 0 agents", async () => {
    const s = setup({ agents: [], tasks: [] });
    const result = await runTeamAnswer(s);

    const state = s.store.get("workbuddy:sess-1234");
    expect(state?.status).toBe("initialized");
    expect(state?.bypassed).toBe(true);
    expect(result.bypassed).toBe(true);
  });

  it("still renders an agent form when the team has >= 2 agents (unchanged)", async () => {
    const s = setup({ agents: TWO_AGENTS, tasks: ONE_TASK });
    const result = await runTeamAnswer(s);

    const state = s.store.get("workbuddy:sess-1234");
    expect(state?.status).toBe("pending_agent_select");
    expect(result.intercepted).toBe(true);
    expect(result.formData?.stage).toBe("agent_select");
  });

  // The same state machine is shared by codex / dsh / opencode — the fix must
  // not be workbuddy-only.
  it("applies the same auto-select for codex / dsh / opencode", async () => {
    for (const source of ["codex", "dsh", "opencode"]) {
      const s = setup({ agents: SOLO_AGENT, tasks: ONE_TASK });
      const result = await runTeamAnswer(s, source);
      const state = s.store.get(`${source}:sess-1234`);
      expect(state?.status, `source=${source}`).toBe("initialized");
      expect(state?.bypassed, `source=${source}`).not.toBe(true);
      expect(result.intercepted, `source=${source}`).toBe(false);
    }
  });

  // Regression guard: the classic CodeBuddy client keeps the single-shot
  // `pending_agent_task` form (agent + task in one dialog) — untouched.
  it("leaves the classic CodeBuddy single-shot path unchanged", async () => {
    const s = setup({ agents: SOLO_AGENT, tasks: ONE_TASK });
    const result = await runTeamAnswer(s, "codebuddy");

    const state = s.store.get("codebuddy:sess-1234");
    expect(state?.status).toBe("pending_agent_task");
    expect(result.intercepted).toBe(true);
    expect(result.formData?.stage).toBe("agent_task");
  });
});
