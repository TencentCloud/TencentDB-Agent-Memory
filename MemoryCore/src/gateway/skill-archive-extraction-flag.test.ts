/**
 * The three archive entry points answer a success with `ok`/`status` and a `task_id`.
 * That answer is accurate — `SkillTriggerService.archive()` writes the archive, appends
 * the task and enqueues it — but it says nothing about whether extraction is configured
 * to run at all. With `skill.extraction.enabled=false` the task is accepted and then
 * cannot be executed, and until now no field in the response said so.
 *
 * These tests pin the field that says it, and pin what it must NOT say:
 *   - it reports the configuration switch, never worker readiness or task completion;
 *   - it is `null` — not `false` — when the resolved config cannot be reached;
 *   - it does not change the archive contract, and it is not injected into errors.
 */
import { describe, test, expect, vi } from "vitest";
import { handleExtract, handleConversationAdd, handleForceArchive } from "./skill-handlers.js";
import type { SkillRouterDeps } from "./skill-handlers.js";
import type { V2AuthContext } from "./v2-schemas.js";

const auth: V2AuthContext = { apiKey: "k", serviceId: "inst-1" };
const RID = "req-test";

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as SkillRouterDeps["logger"];

/** Only the two fields these handlers read off the resolved config. */
const cfgWith = (enabled: boolean) => () => ({
  extraction: { enabled, chunkMaxBytes: 1_000_000, headKeepBytes: 400_000, tailKeepBytes: 400_000 },
  compress: { toolContentThresholdBytes: 4096, headBytes: 1024, tailBytes: 1024 },
}) as unknown as ReturnType<NonNullable<SkillRouterDeps["getResolvedSkillConfig"]>>;

const archiveOk = () => vi.fn(async () => ({ taskId: "task-1", archivedAtMs: 1_700_000_000_000, archiveKey: "k/1" }));

function deps(over: Partial<SkillRouterDeps> & { archive?: ReturnType<typeof archiveOk>; handle?: unknown; buffer?: unknown } = {}): SkillRouterDeps {
  const archive = over.archive ?? archiveOk();
  return {
    getSkillCore: () => undefined,
    logger,
    getResolvedSkillConfig: over.getResolvedSkillConfig,
    resolveConversationAdd: async () => ({
      trigger: { archive },
      handler: { handle: over.handle ?? (async () => ({ status: "ok" })) },
      buffer: over.buffer ?? {
        readCurrent: async () => ({ messages: [{ role: "user", content: "hi" }] }),
        readMeta: async () => ({}),
        writeCurrent: async () => {},
        writeMeta: async () => {},
      },
    }) as never,
    ...over,
  } as SkillRouterDeps;
}

const extractBody = {
  user_id: "u1", team_id: "t1", agent_id: "a1",
  messages: [{ role: "user", content: "how do I fix the exit line" }],
};
const addBody = { ...extractBody, session_id: "s1" };
const forceBody = { space_id: "inst-1", user_id: "u1", team_id: "t1", agent_id: "a1", session_id: "s1" };

describe("extraction switch in the archive responses", () => {
  test("extraction off: the slice is still archived and the task still registered — and the response says the switch is off", async () => {
    const archive = archiveOk();
    const res = await handleExtract(extractBody, auth, RID, deps({ archive, getResolvedSkillConfig: cfgWith(false) }));
    const data = res.data as Record<string, unknown>;
    // the existing contract is untouched
    expect(res.code).toBe(0);
    expect(data.ok).toBe(true);
    expect(data.task_id).toBe("task-1");
    expect(data.archive_key).toBe("k/1");
    // the task really was registered — this is not a "rejected before archiving" change
    expect(archive).toHaveBeenCalledTimes(1);
    // …and the caller can now see why nothing will come of it
    expect(data.extraction_enabled).toBe(false);
  });

  test("extraction on: behaviour unchanged, and `true` is not a claim that extraction finished", async () => {
    const res = await handleExtract(extractBody, auth, RID, deps({ getResolvedSkillConfig: cfgWith(true) }));
    const data = res.data as Record<string, unknown>;
    expect(data.extraction_enabled).toBe(true);
    expect(Object.keys(data).sort()).toEqual(["archive_key", "archived_at_ms", "extraction_enabled", "ok", "task_id"]);
    // nothing in the response speaks about the outcome of extraction
    for (const k of ["skill_id", "candidates", "extracted", "candidate_count"]) expect(data[k]).toBeUndefined();
  });

  test("config unreachable: unknown, never a fabricated `false`", async () => {
    // the dep is optional and may be absent entirely
    const noDep = await handleExtract(extractBody, auth, RID, deps());
    expect((noDep.data as Record<string, unknown>).extraction_enabled).toBeNull();
    // present but the skill config is not resolved yet (skill not constructed)
    const undef = await handleExtract(extractBody, auth, RID, deps({ getResolvedSkillConfig: () => undefined }));
    expect((undef.data as Record<string, unknown>).extraction_enabled).toBeNull();
  });

  test("conversation/add reports the switch below the threshold and at it", async () => {
    const below = await handleConversationAdd(addBody, auth, RID, deps({ getResolvedSkillConfig: cfgWith(false), handle: async () => ({ status: "ok" }) }));
    expect(below.data).toMatchObject({ status: "ok", extraction_enabled: false });

    const at = await handleConversationAdd(addBody, auth, RID, deps({
      getResolvedSkillConfig: cfgWith(false),
      handle: async () => ({ status: "archived", archived: { task_id: "task-9", archived_at_ms: 1, reason: "tool_call_threshold" } }),
    }));
    expect(at.data).toMatchObject({
      status: "archived",
      archived: { task_id: "task-9", reason: "tool_call_threshold" },
      extraction_enabled: false,
    });
  });

  test("force-archive reports the switch on both the empty and the archived answer", async () => {
    const empty = await handleForceArchive(forceBody, auth, RID, deps({
      getResolvedSkillConfig: cfgWith(false),
      buffer: { readCurrent: async () => ({ messages: [] }), readMeta: async () => ({}), writeCurrent: async () => {}, writeMeta: async () => {} },
    }));
    expect(empty.data).toMatchObject({ status: "empty", extraction_enabled: false });

    const archived = await handleForceArchive(forceBody, auth, RID, deps({ getResolvedSkillConfig: cfgWith(false) }));
    expect(archived.data).toMatchObject({ status: "archived", task_id: "task-1", extraction_enabled: false });
  });

  test("a failed archive keeps its original error — the new field does not soften it", async () => {
    const archive = vi.fn(async () => { throw new Error("cos put failed"); }) as unknown as ReturnType<typeof archiveOk>;
    const res = await handleExtract(extractBody, auth, RID, deps({ archive, getResolvedSkillConfig: cfgWith(false) }));
    expect(res.code).toBe(50001);
    expect(res.message).toBe("cos put failed");
    expect((res.data as Record<string, unknown> | undefined)?.extraction_enabled).toBeUndefined();
  });
});
