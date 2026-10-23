import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { StorageAdapter } from "../../storage/adapter.js";
import { LocalStorageBackend } from "../../storage/local-backend.js";
import { LocalSkillAgentTaskQueue, type AgentTuple } from "./agent-task-queue.js";
import { SkillBufferStorage, type SkillTaskEntry } from "./buffer-storage.js";
import { SkillTriggerService } from "./trigger-service.js";
import { SkillConversationExtractWorker, type SkillConversationExtractWorkerOptions, type SkillCandidatesSink } from "./extract-worker.js";
import type { ISkillExtractor } from "../queue/types.js";
import { obsLogger } from "../../report/obs-logger.js";
import { SkillWorkerPool } from "./worker-pool.js";
import type { SkillRestructureOperation, SkillRestructureStatus } from "../skill-restructure-types.js";

vi.mock("../../report/obs-logger.js", () => ({ obsLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../report/trace.js", () => ({ trace: { report: vi.fn() } }));
vi.mock("../../report/otel-context.js", () => ({ runInRootContext: (run: () => unknown) => run() }));

const agent: AgentTuple = { instance_id: "instance", space_id: "space", user_id: "user", team_id: "team", agent_id: "agent" };
const operation = (status: SkillRestructureStatus = "succeeded"): SkillRestructureOperation => ({
  operation_id: "op-1", status, source_skill_id: "source", source_version: 1,
  created_at_ms: 1, updated_at_ms: 2, attempts: 1,
  outputs: status === "succeeded" ? [{ key: "root", skill_id: "published-root", version: 2, name: "result", role: "root", reused: false }] : [],
  ...(["failed", "conflict", "rejected"].includes(status) ? { error: { code: "DIAG_CODE", message: "diagnostic detail" } } : {}),
});
const restructureTask = (): SkillTaskEntry => ({ kind: "restructure", task_id: "skill-restructure-task-op-1", operation_id: "op-1",
  created_at_ms: 1, enqueued_at_ms: 1, space_id: agent.space_id, user_id: agent.user_id, team_id: agent.team_id, agent_id: agent.agent_id });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function enteredBeforeCompletion(entered: Promise<unknown>, running: Promise<unknown>): Promise<void> {
  await Promise.race([entered, running.then(() => { throw new Error("processor was not entered"); })]);
}

describe("skill restructure queue and cancellation (real local buffer/queue)", () => {
  let root: string, buffer: SkillBufferStorage, queue: LocalSkillAgentTaskQueue, trigger: SkillTriggerService;
  let extractor: { extract: Mock<ISkillExtractor["extract"]> }, sink: { applyCandidates: Mock<SkillCandidatesSink["applyCandidates"]> };
  let logger: { info: Mock<(message: string) => void>; warn: Mock<(message: string) => void>; error: Mock<(message: string) => void> };
  let runners: Array<{ stop(): Promise<void> }>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "skill-restructure-queue-"));
    buffer = new SkillBufferStorage({ storage: new StorageAdapter(new LocalStorageBackend(root)) });
    queue = new LocalSkillAgentTaskQueue(); trigger = new SkillTriggerService({ buffer, queue });
    extractor = { extract: vi.fn().mockResolvedValue({ candidates: [] }) };
    sink = { applyCandidates: vi.fn().mockResolvedValue(undefined) };
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }; runners = [];
  });
  afterEach(async () => {
    await Promise.allSettled(runners.map(runner => runner.stop()));
    await rm(root, { recursive: true, force: true });
  });
  const worker = (opts: Partial<SkillConversationExtractWorkerOptions> = {}) => {
    const subject = new SkillConversationExtractWorker({ workerId: "test-worker", buffer, queue, extractor, sink, logger,
      brpopBlockMs: 0, failureRequeueSleepMs: 0, extractLockRenewIntervalMs: 0, lockContentionSleepMs: 0, lockContentionSleepJitterMs: 0, ...opts });
    runners.push(subject); return subject;
  };
  async function putTask(task: SkillTaskEntry) {
    await buffer.writeTasks(agent, { team_id: agent.team_id, agent_id: agent.agent_id, updated_at_ms: 1, tasks: [task] });
    await queue.enqueueAgent(agent);
  }
  async function putExtractTask() {
    const session = { ...agent, session_id: "session" };
    await buffer.writeArchive(session, 1, { messages: [{ role: "user", content: "legacy conversation" }] });
    const task: SkillTaskEntry = { task_id: "legacy-task", session_id: session.session_id, user_id: agent.user_id, team_id: agent.team_id,
      agent_id: agent.agent_id, space_id: agent.space_id, archive_key: buffer.archiveKey(session, 1), archived_at_ms: 1, enqueued_at_ms: 1,
      reason: "legacy reason", max_iterations: 3, mode: "strict" };
    await putTask(task); return task;
  }

  it("enqueues a stable operation task without invented archive/session fields and preserves retries on duplicate enqueue", async () => {
    const input = { ...agent, operation_id: "op-1", created_at_ms: 10 };
    const [first, parallel] = await Promise.all([trigger.enqueueRestructure(input), trigger.enqueueRestructure(input)]);
    expect(first.taskId).toBe("skill-restructure-task-op-1");
    expect(parallel.taskId).toBe(first.taskId);
    expect([first.created, parallel.created].filter(Boolean)).toHaveLength(1);
    const doc = await buffer.readTasks(agent);
    expect(doc.tasks).toHaveLength(1);
    expect(doc.tasks[0]).toMatchObject({ kind: "restructure", operation_id: "op-1", created_at_ms: 10 });
    expect(doc.tasks[0]).not.toHaveProperty("archive_key");
    expect(doc.tasks[0]).not.toHaveProperty("session_id");
    doc.tasks[0].retry_count = 2; doc.tasks[0].last_error = "already processing"; await buffer.writeTasks(agent, doc);
    const second = await trigger.enqueueRestructure({ ...input, created_at_ms: 99, session_id: "later-session" });
    expect(second.taskId).toBe(first.taskId); expect(second.created).toBe(false);
    expect((await buffer.readTasks(agent)).tasks).toEqual(doc.tasks);
    expect(await queue.peekAgent(0)).toEqual(agent);
  });

  for (const status of ["succeeded", "unchanged"] as const) it(`processes ${status} restructure tasks without archive, extractor, or candidate sink`, async () => {
    await putTask(restructureTask()); const readArchive = vi.spyOn(buffer, "readArchive");
    const processor = vi.fn().mockResolvedValue(operation(status));
    const result = await worker({ processRestructure: processor }).consumeAgent(agent);
    expect(processor).toHaveBeenCalledWith("op-1", expect.any(AbortSignal));
    expect(result.processedTaskIds).toEqual(["skill-restructure-task-op-1"]);
    expect((await buffer.readTasks(agent)).tasks).toEqual([]);
    expect(readArchive).not.toHaveBeenCalled(); expect(extractor.extract).not.toHaveBeenCalled(); expect(sink.applyCandidates).not.toHaveBeenCalled();
    expect(logger.info.mock.calls.some(([text]) => String(text).includes("op-1") && String(text).includes(status))).toBe(true);
    if (status === "succeeded") expect(logger.info.mock.calls.some(([text]) => String(text).includes("published-root"))).toBe(true);
  });

  it("keeps prepared/nonterminal operation tasks retryable instead of acknowledging empty extraction", async () => {
    await putTask(restructureTask());
    const result = await worker({ processRestructure: vi.fn().mockResolvedValue(operation("prepared")) }).consumeAgent(agent);
    expect(result.processedTaskIds).toEqual([]);
    expect((await buffer.readTasks(agent)).tasks[0]).toMatchObject({ operation_id: "op-1", retry_count: 1, last_error: expect.stringContaining("SKILL_RESTRUCTURE_PENDING") });
    expect((await buffer.readDlq(agent)).tasks).toEqual([]);
  });

  it("retries publication busy errors with a persisted bounded attempt count and diagnostic operation link", async () => {
    await putTask(restructureTask());
    const error = Object.assign(new Error("400 still busy, not NothingToSave"), { code: "SKILL_PUBLICATION_BUSY", retryable: true });
    const subject = worker({ processRestructure: vi.fn().mockRejectedValue(error), restructureMaxRetries: 2 });
    await subject.consumeAgent(agent);
    expect((await buffer.readTasks(agent)).tasks[0]).toMatchObject({ retry_count: 1, operation_id: "op-1" });
    await subject.consumeAgent(agent);
    expect((await buffer.readTasks(agent)).tasks).toEqual([]);
    expect((await buffer.readDlq(agent)).tasks[0]).toMatchObject({ kind: "restructure", operation_id: "op-1", retry_count: 2,
      last_error: expect.stringContaining("SKILL_PUBLICATION_BUSY") });
    expect(sink.applyCandidates).not.toHaveBeenCalled();
  });

  for (const status of ["failed", "rejected", "conflict"] as const) it(`records terminal ${status} operation in DLQ without reporting success`, async () => {
    await putTask(restructureTask());
    const result = await worker({ processRestructure: vi.fn().mockResolvedValue(operation(status)) }).consumeAgent(agent);
    expect(result.processedTaskIds).toEqual([]);
    expect((await buffer.readTasks(agent)).tasks).toEqual([]);
    expect((await buffer.readDlq(agent)).tasks[0]).toMatchObject({ operation_id: "op-1", last_error: expect.stringContaining(status) });
    expect((await buffer.readDlq(agent)).tasks[0].last_error).toContain("DIAG_CODE");
    expect(sink.applyCandidates).not.toHaveBeenCalled();
  });

  for (const failure of ["lost", "throws"] as const) it(`aborts when renewal ${failure} and does not acknowledge success returned after cancellation`, async () => {
    await putTask(restructureTask()); const entered = deferred<void>(); let active = false; let seen: AbortSignal | undefined;
    const renew = queue.renewExtractLock.bind(queue);
    vi.spyOn(queue, "renewExtractLock").mockImplementation(async (...args) => {
      if (!active) return renew(...args);
      if (failure === "throws") throw new Error("lease transport unavailable");
      return false;
    });
    const processor = vi.fn(async (_id: string, signal: AbortSignal) => {
      seen = signal; active = true; entered.resolve();
      return new Promise<SkillRestructureOperation>(resolve => signal.addEventListener("abort", () => resolve(operation()), { once: true }));
    });
    const running = worker({ processRestructure: processor, extractLockRenewIntervalMs: 5 }).consumeAgent(agent);
    await enteredBeforeCompletion(entered.promise, running);
    const result = await running;
    expect(seen?.aborted).toBe(true); expect(result.processedTaskIds).toEqual([]);
    expect((await buffer.readTasks(agent)).tasks).toHaveLength(1);
  });

  it("stop aborts an active restructure processor while keeping its original task", async () => {
    await putTask(restructureTask()); const entered = deferred<void>(); let seen: AbortSignal | undefined;
    const subject = worker({ processRestructure: async (_id, signal) => {
      seen = signal; entered.resolve();
      return new Promise(resolve => signal.addEventListener("abort", () => resolve(operation()), { once: true }));
    } });
    const running = subject.consumeAgent(agent); await enteredBeforeCompletion(entered.promise, running);
    await subject.stop(); const result = await running;
    expect(seen?.aborted).toBe(true); expect(result.processedTaskIds).toEqual([]);
    expect((await buffer.readTasks(agent)).tasks).toHaveLength(1);
  });

  it("pool resolves restructure lazily without requiring an LLM and propagates stop cancellation", async () => {
    await putTask(restructureTask()); let seen: AbortSignal | undefined;
    const resolveExtractor = vi.fn().mockRejectedValue(new Error("LLM must not be built"));
    const resolveSink = vi.fn().mockRejectedValue(new Error("sink must not be built"));
    const pool = new SkillWorkerPool({ concurrency: 1, queue, logger, resolveBuffer: async () => buffer, resolveExtractor, resolveSink,
      resolveRestructure: async () => async (_id, signal) => {
        seen = signal;
        return new Promise(resolve => signal.addEventListener("abort", () => resolve(operation()), { once: true }));
      }, extractLockRenewIntervalMs: 0, failureRequeueSleepMs: 0 });
    runners.push(pool);
    pool.start();
    await vi.waitFor(() => expect(seen).toBeDefined(), { timeout: 2000, interval: 10 });
    await pool.stop();
    expect(seen?.aborted).toBe(true); expect(resolveExtractor).not.toHaveBeenCalled(); expect(resolveSink).not.toHaveBeenCalled();
    expect((await buffer.readTasks(agent)).tasks).toHaveLength(1);
  });

  it("preserves legacy extraction, option forwarding, sink behavior, and passes both cancellation spellings", async () => {
    const task = await putExtractTask(); extractor.extract.mockResolvedValue({ candidates: [{ action: "create", name: "legacy", skill_id: "legacy-skill" }] });
    expect((await worker().consumeAgent(agent)).processedTaskIds).toEqual([task.task_id]);
    const input = extractor.extract.mock.calls[0][0];
    expect(input).toMatchObject({ conversation: [{ role: "user", content: "legacy conversation" }], reason: "legacy reason", options: { max_iterations: 3 }, mode: "strict" });
    expect(input.abortSignal).toBeInstanceOf(AbortSignal); expect(input.signal).toBe(input.abortSignal);
    expect(sink.applyCandidates).toHaveBeenCalledTimes(1); expect((await buffer.readTasks(agent)).tasks).toEqual([]);
  });

  it("keeps the legacy worker phase events for existing operational dashboards", async () => {
    await putExtractTask(); await worker().consumeAgent(agent);
    const events = vi.mocked(obsLogger.info).mock.calls.map(([event]) => event);
    expect(events).toEqual(expect.arrayContaining(["skill.worker.consume_start", "skill.worker.acquire_lock", "skill.worker.read_head",
      "skill.worker.read_archive", "skill.worker.extractor", "skill.worker.apply_candidates", "skill.worker.delete_task", "skill.worker.task_done", "skill.worker.consume_done"]));
  });

  it("rejects an unbounded or nonpositive restructure retry budget", () => {
    expect(() => worker({ restructureMaxRetries: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => worker({ restructureMaxRetries: 0 })).toThrow();
  });

  it("does not sink or acknowledge legacy extraction after external cancellation", async () => {
    await putExtractTask(); const entered = deferred<void>(); const resume = deferred<{ candidates: [] }>(); const parent = new AbortController();
    extractor.extract.mockImplementation(async () => { entered.resolve(); return resume.promise; });
    const running = worker().consumeAgent(agent, parent.signal); await enteredBeforeCompletion(entered.promise, running);
    parent.abort(); resume.resolve({ candidates: [] }); await running;
    expect(sink.applyCandidates).not.toHaveBeenCalled(); expect((await buffer.readTasks(agent)).tasks).toHaveLength(1);
  });

  it("rechecks cancellation after reading the acknowledgement document", async () => {
    await putExtractTask(); const parent = new AbortController(); let reads = 0; const read = buffer.readTasks.bind(buffer);
    vi.spyOn(buffer, "readTasks").mockImplementation(async a => { const doc = await read(a); if (++reads === 2) parent.abort(); return doc; });
    await worker().consumeAgent(agent, parent.signal);
    expect((await read(agent)).tasks).toHaveLength(1);
  });

  it("detects lease loss after legacy extraction even when periodic renewal is disabled", async () => {
    await putExtractTask(); let lost = false; let seen: AbortSignal | undefined;
    const renew = queue.renewExtractLock.bind(queue);
    vi.spyOn(queue, "renewExtractLock").mockImplementation(async (...args) => lost ? false : renew(...args));
    extractor.extract.mockImplementation(async input => { seen = input.abortSignal; lost = true; return { candidates: [] }; });
    const result = await worker({ extractLockRenewIntervalMs: 0 }).consumeAgent(agent);
    expect(result.cancelled).toBe(true); expect(seen?.aborted).toBe(true);
    expect(sink.applyCandidates).not.toHaveBeenCalled(); expect((await buffer.readTasks(agent)).tasks).toHaveLength(1);
  });

  it("preserves legacy ghost dropping and transient retry behavior", async () => {
    const task = await putExtractTask(); const readArchive = vi.spyOn(buffer, "readArchive").mockResolvedValueOnce(null);
    const subject = worker();
    expect((await subject.consumeAgent(agent)).dropped).toEqual([task.task_id]);
    expect(extractor.extract).not.toHaveBeenCalled(); expect(sink.applyCandidates).not.toHaveBeenCalled();
    readArchive.mockRestore(); await putExtractTask();
    extractor.extract.mockRejectedValue(new Error("HTTP 429 rate limit"));
    await subject.consumeAgent(agent); await subject.consumeAgent(agent);
    expect((await buffer.readTasks(agent)).tasks[0].retry_count).toBeUndefined();
    expect((await buffer.readDlq(agent)).tasks).toEqual([]);
  });

  it("does not remove the original task when cancelled after the durable DLQ write", async () => {
    await putTask(restructureTask()); const parent = new AbortController(); const append = buffer.appendDlq.bind(buffer);
    vi.spyOn(buffer, "appendDlq").mockImplementation(async (...args) => { await append(...args); parent.abort(); });
    await worker({ processRestructure: vi.fn().mockResolvedValue(operation("failed")) }).consumeAgent(agent, parent.signal);
    expect((await buffer.readTasks(agent)).tasks).toHaveLength(1); expect((await buffer.readDlq(agent)).tasks).toHaveLength(1);
  });

  it("keeps the original task if durable DLQ append fails", async () => {
    await putExtractTask(); extractor.extract.mockRejectedValue(new Error("HTTP 400 bad input"));
    vi.spyOn(buffer, "appendDlq").mockRejectedValue(new Error("storage unavailable"));
    await worker({ permanentMaxRetries: 1 }).consumeAgent(agent).catch(() => undefined);
    expect((await buffer.readTasks(agent)).tasks).toHaveLength(1);
    expect((await buffer.readDlq(agent)).tasks).toEqual([]);
  });

  it("persists DLQ first and deduplicates it when removing the original task must be retried", async () => {
    await putTask(restructureTask()); const write = buffer.writeTasks.bind(buffer); let fail = true;
    vi.spyOn(buffer, "writeTasks").mockImplementation(async (a, doc) => { if (fail && doc.tasks.length === 0) { fail = false; throw new Error("ack write unavailable"); } await write(a,doc); });
    const subject = worker({ processRestructure: vi.fn().mockResolvedValue(operation("failed")) });
    await subject.consumeAgent(agent).catch(() => undefined);
    expect((await buffer.readTasks(agent)).tasks).toHaveLength(1); expect((await buffer.readDlq(agent)).tasks).toHaveLength(1);
    await subject.consumeAgent(agent);
    expect((await buffer.readTasks(agent)).tasks).toEqual([]); expect((await buffer.readDlq(agent)).tasks).toHaveLength(1);
  });
});
