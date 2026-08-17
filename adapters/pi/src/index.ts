import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createConversationMessages, lastSuccessfulAssistantText } from "./capture.js";
import { createClients, createSessionMemoryClient } from "./clients.js";
import { loadConfig } from "./config.js";
import { enqueueCapture, flushOutbox } from "./outbox.js";
import { createSkillMessages, enqueueSkillTurn, type SkillToolCall } from "./skill-capture.js";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { installSyncedSkill, listSyncCandidates } from "./skill-sync.js";
import { injectRecall, recallMemory } from "./recall.js";
import { BRANCH_ENTRY_TYPE, createBranchId, memorySessionId, restoreBranchId } from "./session.js";
import { runSetup } from "./setup.js";
import { checkStatus, formatStatus } from "./status.js";
import {
  conversationSearch,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_QUERY_CHARS,
  MAX_SESSION_KEY_CHARS,
  memorySearch,
  memorySearchMessage,
  skillRead,
  skillSearch,
} from "./tools.js";
import type { ConfigResult } from "./types.js";

const STATUS_KEY = "tdai-memory";
const MEMORY_SEARCH_TOOLS = new Set(["tdai_memory_search", "tdai_conversation_search"]);
const SKILL_TOOLS = new Set(["tdai_skill_search", "tdai_skill_read"]);
// Any adapter tool whose read-back must never be re-learned: the memory
// search tools (L0/L1 evidence) plus the skill tools themselves.
const SELF_TOOLS = new Set([...MEMORY_SEARCH_TOOLS, ...SKILL_TOOLS]);

type TimedOutcome<T> = { ok: true; value: T } | { ok: false };

interface TurnState {
  activePrompt: string | undefined;
  finalAssistant: string | undefined;
  successfulToolResults: Array<{ toolName: string; isError: boolean; content: unknown }>;
  toolCalls: Map<string, SkillToolCall>;
  toolCallOrder: string[];
  memoryToolCallsThisTurn: number;
}

async function settleWithin<T>(work: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const guarded = work.then<TimedOutcome<T>, TimedOutcome<T>>(
    (value) => ({ ok: true, value }),
    () => ({ ok: false }),
  );
  const outcome = await Promise.race([
    guarded,
    new Promise<TimedOutcome<T>>((resolve) => {
      timeoutHandle = setTimeout(() => resolve({ ok: false }), timeoutMs);
    }),
  ]);
  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  return outcome.ok ? outcome.value : undefined;
}

export default function tdaiMemoryExtension(pi: ExtensionAPI): void {
  let currentConfig: ConfigResult | undefined;
  const turnStates = new Map<string, TurnState>();
  const branchBySessionId = new Map<string, string>();

  const sessionIdOf = (ctx: { sessionManager: { getSessionId: () => string } }): string =>
    ctx.sessionManager.getSessionId();

  const createTurnState = (): TurnState => ({
    activePrompt: undefined,
    finalAssistant: undefined,
    successfulToolResults: [],
    toolCalls: new Map(),
    toolCallOrder: [],
    memoryToolCallsThisTurn: 0,
  });

  const getOrCreateTurnState = (sessionId: string): TurnState => {
    let state = turnStates.get(sessionId);
    if (!state) {
      state = createTurnState();
      turnStates.set(sessionId, state);
    }
    return state;
  };

  const memoryUnavailable = () => memorySearchMessage("Memory not configured. Continue without memory.");
  const memorySearchTimedOut = () => memorySearchMessage("Memory search unavailable. Continue without memory.");
  const memoryToolLimitReached = () =>
    memorySearchMessage("Memory search limit reached for this turn. Use existing information to answer.");
  const skillsUnavailable = () => memorySearchMessage("Skills not configured. Continue without skills.");

  pi.registerTool({
    name: "tdai_memory_search",
    label: "Search memory",
    description: "Search structured memories (L1): user preferences, past events, rules, facts.",
    promptSnippet: "Search L1 memories when needed; use both memory search tools at most 3 times total per turn, then answer from existing information.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: MAX_SEARCH_QUERY_CHARS }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_LIMIT })),
      type: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      if (!currentConfig?.ok || !currentConfig.config.enabled) return memoryUnavailable();
      const state = getOrCreateTurnState(sessionIdOf(ctx));
      if (state.memoryToolCallsThisTurn >= 3) return memoryToolLimitReached();
      state.memoryToolCallsThisTurn += 1;
      return (
        (await settleWithin(
          memorySearch(createClients(currentConfig.config).memory, params),
          currentConfig.config.recall.deadlineMs,
        )) ?? memorySearchTimedOut()
      );
    },
  });

  pi.registerTool({
    name: "tdai_conversation_search",
    label: "Search conversation history",
    description: "Search raw conversation history (L0) with timestamps.",
    promptSnippet: "Search L0 conversations when needed; use both memory search tools at most 3 times total per turn, then answer from existing information.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: MAX_SEARCH_QUERY_CHARS }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_LIMIT })),
      session_key: Type.Optional(Type.String({ maxLength: MAX_SESSION_KEY_CHARS })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      if (!currentConfig?.ok || !currentConfig.config.enabled) return memoryUnavailable();
      const state = getOrCreateTurnState(sessionIdOf(ctx));
      if (state.memoryToolCallsThisTurn >= 3) return memoryToolLimitReached();
      state.memoryToolCallsThisTurn += 1;
      return (
        (await settleWithin(
          conversationSearch(createClients(currentConfig.config).memory, params),
          currentConfig.config.recall.deadlineMs,
        )) ?? memorySearchTimedOut()
      );
    },
  });

  pi.registerTool({
    name: "tdai_skill_search",
    label: "Search skills",
    description: "Search learned skills (SKILL.md) by name, description and snippet.",
    promptSnippet: "Search learned skills when relevant; use memory and skill tools at most 3 times total per turn, then answer from existing information.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: MAX_SEARCH_QUERY_CHARS }),
      top_k: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_LIMIT })),
      scope: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      if (
        !currentConfig?.ok ||
        !currentConfig.config.enabled ||
        !currentConfig.config.skills.enabled ||
        !currentConfig.config.skills.runtimeTools
      ) {
        return skillsUnavailable();
      }
      const state = getOrCreateTurnState(sessionIdOf(ctx));
      if (state.memoryToolCallsThisTurn >= 3) return memoryToolLimitReached();
      state.memoryToolCallsThisTurn += 1;
      return (
        (await settleWithin(
          skillSearch(
            createClients(currentConfig.config).skill,
            params,
            currentConfig.config.skills.allowTeamSearch,
            currentConfig.config.skills.routingMode,
          ),
          currentConfig.config.recall.deadlineMs,
        )) ?? memorySearchTimedOut()
      );
    },
  });

  pi.registerTool({
    name: "tdai_skill_read",
    label: "Read skill",
    description: "Read a learned skill's SKILL.md body or a specific resource file.",
    promptSnippet: "Read a skill's full SKILL.md when a search result needs more detail; use memory and skill tools at most 3 times total per turn.",
    parameters: Type.Object({
      skill_id: Type.String({ minLength: 1, maxLength: MAX_SESSION_KEY_CHARS }),
      path: Type.Optional(Type.String({ maxLength: MAX_SESSION_KEY_CHARS })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      if (
        !currentConfig?.ok ||
        !currentConfig.config.enabled ||
        !currentConfig.config.skills.enabled ||
        !currentConfig.config.skills.runtimeTools
      ) {
        return skillsUnavailable();
      }
      const state = getOrCreateTurnState(sessionIdOf(ctx));
      if (state.memoryToolCallsThisTurn >= 3) return memoryToolLimitReached();
      state.memoryToolCallsThisTurn += 1;
      return (
        (await settleWithin(
          skillRead(createClients(currentConfig.config).skill, params),
          currentConfig.config.recall.deadlineMs,
        )) ?? memorySearchTimedOut()
      );
    },
  });

  pi.registerCommand("tdai-memory-setup", {
    description: "Interactively configure TencentDB Agent Memory for Pi",
    handler: async (_args, ctx) => {
      const setup = await runSetup(ctx);
      if (!setup.ok) {
        ctx.ui.setStatus(STATUS_KEY, "memory: setup incomplete");
        ctx.ui.notify(setup.message, setup.cancelled ? "warning" : "error");
        return;
      }

      currentConfig = await loadConfig({
        cwd: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted(),
      });
      if (!currentConfig.ok || !currentConfig.config.enabled) {
        ctx.ui.setStatus(STATUS_KEY, "memory: setup needs attention");
        const details = !currentConfig.ok ? currentConfig.errors.join("; ") : "adapter is disabled";
        ctx.ui.notify(`Memory setup saved, but configuration could not be activated: ${details}`, "error");
        return;
      }

      ctx.ui.setStatus(STATUS_KEY, "memory: configured");
      ctx.ui.notify(
        setup.createdAgent
          ? "Memory setup complete. A private Pi Agent was created and the extension was reloaded."
          : "Memory setup complete. The extension was reloaded.",
        "info",
      );
      await ctx.reload();
    },
  });

  pi.registerCommand("tdai-memory-status", {
    description: "Check TencentDB Agent Memory configuration, identity, and connectivity",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus(STATUS_KEY, "memory: checking config");
      const config =
        currentConfig ??
        (await loadConfig({
          cwd: ctx.cwd,
          projectTrusted: ctx.isProjectTrusted(),
        }));
      ctx.ui.setStatus(STATUS_KEY, "memory: checking connection");
      const status = await checkStatus(config, (phase) => {
        ctx.ui.setStatus(STATUS_KEY, `memory: checking ${phase}`);
      });
      ctx.ui.setStatus(STATUS_KEY, status.summary);
      const kind = status.kind === "ready" || status.kind === "disabled" ? "info" : status.kind === "offline" ? "warning" : "error";
      ctx.ui.notify(formatStatus(status), kind);
    },
  });

  pi.registerCommand("tdai-memory-sync-skills", {
    description: "Preview and sync server-side skills into Pi's native skills directory",
    handler: async (_args, ctx) => {
      if (!currentConfig?.ok || !currentConfig.config.enabled) {
        ctx.ui.setStatus(STATUS_KEY, "memory: not configured");
        ctx.ui.notify("Memory is not configured. Run /tdai-memory-setup first.", "error");
        return;
      }
      const config = currentConfig.config;
      const skill = createClients(config).skill;
      const agentDir = getAgentDir();
      const source = { endpoint: config.endpoint, teamId: config.teamId, agentId: config.agentId };

      ctx.ui.setStatus(STATUS_KEY, "skills: listing");
      let candidates;
      try {
        candidates = await listSyncCandidates(skill);
      } catch (error) {
        ctx.ui.setStatus(STATUS_KEY, "memory: skills unavailable");
        ctx.ui.notify(`Could not list skills: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      if (candidates.length === 0) {
        ctx.ui.setStatus(STATUS_KEY, "memory: skills empty");
        ctx.ui.notify("No skills found on the server yet. Skills appear after the server mines a conversation.", "info");
        return;
      }

      const optionOf = (candidate: { name: string; version: number }) => `${candidate.name} (v${candidate.version})`;
      const options = ["all", ...candidates.map(optionOf)];
      const selectedLabel = ctx.hasUI
        ? (await ctx.ui.select("Sync which skills into Pi?", options)) ?? "all"
        : "all";
      const selectedIds = selectedLabel === "all"
        ? candidates.map((candidate) => candidate.skill_id)
        : candidates.filter((candidate) => optionOf(candidate) === selectedLabel).map((candidate) => candidate.skill_id);
      if (selectedIds.length === 0) {
        ctx.ui.notify("No matching skill selected; nothing to sync.", "warning");
        return;
      }

      if (ctx.hasUI) {
        const proceed = await ctx.ui.confirm(
          "Sync skills to Pi",
          `Download ${selectedIds.length} skill${selectedIds.length === 1 ? "" : "s"} into ${agentDir}\\skills? Local files with the same name are kept unless they were synced before.`,
        );
        if (!proceed) {
          ctx.ui.notify("Skill sync cancelled.", "info");
          return;
        }
      }

      const results: Array<{ name: string; status: string }> = [];
      for (const skillId of selectedIds) {
        ctx.ui.setStatus(STATUS_KEY, `skills: syncing ${results.length + 1}/${selectedIds.length}`);
        try {
          const result = await installSyncedSkill({ skill, agentDir, skillId, source });
          results.push({ name: result.name, status: result.status });
          ctx.ui.notify(
            result.status === "synced"
              ? `Synced skill "${result.name}" (v${result.version}) to Pi.`
              : result.status === "skipped-user-owned"
                ? `Skipped "${result.name}": a user-written skill with that name already exists locally.`
                : `Failed to sync "${result.name}": ${result.error ?? "unknown"}`,
            result.status === "synced" ? "info" : "warning",
          );
        } catch (error) {
          results.push({ name: skillId, status: "failed" });
          ctx.ui.notify(`Sync failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
      }

      const synced = results.filter((result) => result.status === "synced").length;
      ctx.ui.setStatus(STATUS_KEY, synced > 0 ? "memory: skills synced" : "memory: skills unchanged");
      ctx.ui.notify(
        `Skill sync complete: ${synced} synced, ${results.length - synced} skipped/failed. Reloading to discover new skills.`,
        synced > 0 ? "info" : "info",
      );
      await ctx.reload();
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    branchBySessionId.set(sessionIdOf(ctx), restoreBranchId(ctx.sessionManager.getBranch()) ?? "root");
    currentConfig = await loadConfig({
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted(),
    });
    if (!currentConfig.ok) {
      ctx.ui.setStatus(STATUS_KEY, "memory: not configured");
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, currentConfig.config.enabled ? "memory: configured" : "memory: disabled");
    const loadedConfig = currentConfig.config;
    if (loadedConfig.enabled) {
      // Catch-up delivery of records left over from an offline period. This is
      // background work about PAST sessions: it must not write a status, or its
      // async `.then` could race `before_agent_start` and clobber `memory:
      // recalled` with `memory: captured` (which is reserved for the CURRENT
      // turn, set by agent_settled).
      void flushOutbox(loadedConfig, async (record) => {
        const memory = createSessionMemoryClient(loadedConfig, record.sessionId);
        await memory.addConversation({ messages: record.messages });
      }).catch(() => undefined);
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    const restored = restoreBranchId(ctx.sessionManager.getBranch());
    if (restored) {
      branchBySessionId.set(sessionIdOf(ctx), restored);
      return;
    }
    const branchId = createBranchId();
    branchBySessionId.set(sessionIdOf(ctx), branchId);
    pi.appendEntry(BRANCH_ENTRY_TYPE, { branchId, createdAt: new Date().toISOString() });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const state = createTurnState();
    state.activePrompt = event.prompt;
    turnStates.set(sessionIdOf(ctx), state);
    if (!currentConfig?.ok || !currentConfig.config.enabled) return;
    try {
      const recalled = await settleWithin(
        recallMemory(
          createClients(currentConfig.config),
          event.prompt,
          currentConfig.config.recall,
          currentConfig.config.skills,
        ),
        currentConfig.config.recall.deadlineMs,
      );
      if (!recalled?.content) {
        if (!recalled) {
          ctx.ui.setStatus(STATUS_KEY, "memory: recall unavailable");
          return;
        }
        if (recalled.failedLayers.length > 0 || recalled.timedOutLayers.length > 0) {
          ctx.ui.setStatus(STATUS_KEY, "memory: recall unavailable");
        }
        return;
      }
      ctx.ui.setStatus(
        STATUS_KEY,
        recalled.failedLayers.length > 0 || recalled.timedOutLayers.length > 0
          ? "memory: recalled (partial)"
          : "memory: recalled",
      );
      return { systemPrompt: injectRecall(event.systemPrompt, recalled.content) };
    } catch {
      ctx.ui.setStatus(STATUS_KEY, "memory: recall unavailable");
      return;
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    // A later failed/cancelled run must clear a prior successful answer: only
    // the final settled run is eligible for persistence.
    getOrCreateTurnState(sessionIdOf(ctx)).finalAssistant = lastSuccessfulAssistantText(event.messages);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (
      !currentConfig?.ok ||
      !currentConfig.config.enabled ||
      !currentConfig.config.skills.enabled ||
      !currentConfig.config.skills.capture ||
      SELF_TOOLS.has(event.toolName)
    ) {
      return;
    }
    const state = getOrCreateTurnState(sessionIdOf(ctx));
    state.toolCalls.set(event.toolCallId, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
    });
    state.toolCallOrder.push(event.toolCallId);
  });

  pi.on("tool_result", async (event, ctx) => {
    const state = getOrCreateTurnState(sessionIdOf(ctx));
    if (
      currentConfig?.ok &&
      currentConfig.config.enabled &&
      currentConfig.config.captureTools &&
      !event.isError &&
      !MEMORY_SEARCH_TOOLS.has(event.toolName)
    ) {
      state.successfulToolResults.push({
        toolName: event.toolName,
        isError: event.isError,
        content: event.content,
      });
    }
    if (
      currentConfig?.ok &&
      currentConfig.config.enabled &&
      currentConfig.config.skills.enabled &&
      currentConfig.config.skills.capture &&
      !SELF_TOOLS.has(event.toolName)
    ) {
      const call = state.toolCalls.get(event.toolCallId);
      if (call) call.result = { content: event.content, isError: event.isError };
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const sessionId = sessionIdOf(ctx);
    const state = turnStates.get(sessionId);
    turnStates.delete(sessionId);
    if (!state) return;
    const prompt = state.activePrompt;
    const assistant = state.finalAssistant;
    const toolResults = state.successfulToolResults;
    if (!prompt || !assistant || !currentConfig?.ok || !currentConfig.config.enabled) return;
    try {
      const captureSessionId = memorySessionId(sessionId, branchBySessionId.get(sessionId) ?? "root");
      const loadedConfig = currentConfig.config;
      const record = await enqueueCapture(loadedConfig, captureSessionId, createConversationMessages(prompt, assistant, toolResults));
      pi.appendEntry("tdai-memory/capture-queued@1", {
        sessionId: captureSessionId,
        captureId: record.id,
        capturedAt: new Date().toISOString(),
      });
      ctx.ui.setStatus(STATUS_KEY, "memory: capture queued");
      void flushOutbox(loadedConfig, async (queued) => {
        const memory = createSessionMemoryClient(loadedConfig, queued.sessionId);
        await memory.addConversation({ messages: queued.messages });
      }).then((result) => {
        if (result.delivered > 0) ctx.ui.setStatus(STATUS_KEY, "memory: captured");
      }).catch(() => undefined);

      // Skill learning ingest: independent of L0, at-most-once, never blocks.
      if (loadedConfig.skills.enabled && loadedConfig.skills.capture) {
        const skillCalls = state.toolCallOrder
          .map((id) => state.toolCalls.get(id))
          .filter((call): call is SkillToolCall => call !== undefined);
        const skillMessages = createSkillMessages({
          prompt,
          finalAssistant: assistant,
          toolCalls: skillCalls,
          options: loadedConfig.skills,
        });
        void enqueueSkillTurn(loadedConfig, captureSessionId, skillMessages)
          .then((status) => {
            if (status === "uncertain") ctx.ui.setStatus(STATUS_KEY, "memory: skill uncertain");
          })
          .catch(() => undefined);
      }
    } catch {
      ctx.ui.setStatus(STATUS_KEY, "memory: capture failed");
    }
  });
}
