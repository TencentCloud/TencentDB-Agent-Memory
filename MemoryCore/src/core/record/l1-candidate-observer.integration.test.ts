import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CandidateObserver, CandidateObservationSnapshot } from "./l1-candidate-observer.js";

const fake = vi.hoisted(() => ({
  id: 0,
  dedup: vi.fn(), writer: vi.fn(), runner: vi.fn(), format: vi.fn(),
  system: vi.fn(), compose: vi.fn(),
}));
vi.mock("./l1-dedup.js", () => ({ batchDedup: fake.dedup }));
vi.mock("./l1-writer.js", () => ({ writeMemory: fake.writer, generateMemoryId: () => `candidate-${++fake.id}` }));
vi.mock("../prompts/l1-extraction.js", () => ({ formatExtractionPrompt: fake.format, getExtractMemoriesSystemPrompt: fake.system }));
vi.mock("../memory-prompt/composer.js", () => ({ composeMemorySystemPrompt: fake.compose }));
vi.mock("../../utils/clean-context-runner.js", () => ({ CleanContextRunner: class { run = fake.runner; } }));
vi.mock("../../utils/sanitize.js", () => ({ sanitizeJsonForParse: (value: string) => value, shouldExtractL1: () => true }));
vi.mock("../report/reporter.js", () => ({ report: vi.fn() }));
vi.mock("../report/kafka-metric-producer.js", () => ({ metricProducer: { send: vi.fn() } }));
vi.mock("../report/metric-tracking-l1-latency.js", () => ({ reportL1LatencyMetrics: vi.fn() }));
vi.mock("../storage/adapter.js", () => ({ StorageAdapter: class {} }));
vi.mock("../storage/local-backend.js", () => ({ LocalStorageBackend: class {} }));
vi.mock("../memory-generation-log/store.js", () => ({
  buildGenerationLogIdentity: () => ({ logId: "log", generationId: "generation", key: "key" }),
  buildGenerationProvenance: () => ({}), buildPromptGenerationRef: () => ({}),
  MemoryGenerationLogStore: class { write = vi.fn(); },
}));
vi.mock("../memory-generation-log/best-effort.js", () => ({ writeGenerationProvenanceBestEffort: vi.fn() }));
vi.mock("../memory-generation-log/types.js", () => ({ buildMemoryGenerationRefId: () => "ref" }));

import { extractL1Memories } from "./l1-extractor.js";

const user = { id: "message-1", role: "user" as const, content: "Use the existing extractor result", timestamp: 1 };
const scene = [{ scene_name: "original scene", message_ids: [user.id], memories: [
  { content: "original candidate one", type: "instruction", priority: 50, source_message_ids: [user.id], metadata: {} },
  { content: "original candidate two", type: "persona", priority: 60, source_message_ids: [user.id], metadata: {} },
] }];
function reset(path: "dedup" | "dedup_fallback" | "dedup_disabled") {
  fake.id = 0;
  for (const mock of [fake.dedup, fake.writer, fake.runner, fake.format, fake.system, fake.compose]) mock.mockReset();
  fake.runner.mockResolvedValue(JSON.stringify(scene));
  fake.format.mockImplementation((value) => JSON.stringify(value));
  fake.system.mockReturnValue("existing system prompt sentinel");
  fake.compose.mockImplementation((value) => value);
  if (path === "dedup_fallback") fake.dedup.mockRejectedValue(Error("existing dedup failure"));
  else fake.dedup.mockResolvedValue([
    { record_id: "candidate-1", action: "update", target_ids: ["original-target"], merged_content: "original merge" },
    { record_id: "candidate-2", action: "skip", target_ids: [] },
  ]);
  fake.writer.mockImplementation(async ({ memory, decision }) => decision.action === "skip" ? null : { ...memory, id: memory.record_id });
}
async function run(path: "dedup" | "dedup_fallback" | "dedup_disabled", observer?: CandidateObserver, mode: "off" | "shadow" = "shadow", timeoutMs = 100) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const result = await extractL1Memories({
    messages: [user], sessionKey: "original session", baseDir: "unused-fixture", config: {}, logger,
    options: { enableDedup: path !== "dedup_disabled", llmRunner: { run: fake.runner }, candidateObserver: observer ? { mode, observer, timeoutMs } : undefined },
  });
  return {
    result, logger,
    writerArguments: fake.writer.mock.calls.map(([params]) => ({ ...params, logger: undefined })),
    runnerArguments: fake.runner.mock.calls,
    dedupArguments: fake.dedup.mock.calls.map(([params]) => ({ ...params, logger: undefined })),
  };
}
describe("shadow integration with the actual tracked extractor", () => {
  beforeEach(() => reset("dedup"));
  it.each(["dedup", "dedup_fallback", "dedup_disabled"] as const)("observes %s exactly once, preserving existing LLM and writer arguments", async (path) => {
    reset(path);
    const baseline = await run(path);
    reset(path);
    const observer = vi.fn((snapshot: CandidateObservationSnapshot) => {
      expect(fake.writer).not.toHaveBeenCalled();
      expect(snapshot.path).toBe(path);
      expect(snapshot.sourceMessages).toEqual([user]);
      expect(snapshot.candidates.map((candidate) => candidate.record_id)).toEqual(["candidate-1", "candidate-2"]);
      expect(snapshot.decisions.map((decision) => decision.action)).toEqual(path === "dedup" ? ["update", "skip"] : ["store", "store"]);
      return snapshot.candidates.map((candidate) => ({ candidate_id: candidate.record_id, disposition: "reject", reason: "temporary", confidence: 1 }));
    });
    const shadow = await run(path, observer);
    expect(observer).toHaveBeenCalledOnce();
    expect(shadow.writerArguments).toEqual(baseline.writerArguments);
    expect(shadow.runnerArguments).toEqual(baseline.runnerArguments);
    expect(shadow.dedupArguments).toEqual(baseline.dedupArguments);
    expect(shadow.result).toEqual(baseline.result);
    expect(fake.runner).toHaveBeenCalledOnce();
    expect(fake.dedup).toHaveBeenCalledTimes(path === "dedup_disabled" ? 0 : 1);
    expect(fake.writer).toHaveBeenCalledTimes(2);
  });
  it.each(["dedup", "dedup_fallback", "dedup_disabled"] as const)("observer failure logs explicitly but leaves the %s writer path intact", async (path) => {
    reset(path);
    const baseline = await run(path);
    reset(path);
    const observer = vi.fn(() => { throw Error("private observation failure"); });
    const shadow = await run(path, observer);
    expect(shadow.writerArguments).toEqual(baseline.writerArguments);
    expect(shadow.result).toEqual(baseline.result);
    expect(observer).toHaveBeenCalledOnce();
    const events = shadow.logger.warn.mock.calls.filter(([line]) => line.includes('"event":"l1_candidate_observer"'));
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0][0]).reason).toBe("observer_error");
    expect(events[0][0]).not.toContain("private observation failure");
  });
  it.each(["dedup", "dedup_fallback", "dedup_disabled"] as const)("explicit off does not call the configured observer on %s", async (path) => {
    reset(path);
    const observer = vi.fn();
    const result = await run(path, observer, "off");
    expect(observer).not.toHaveBeenCalled();
    expect(fake.runner).toHaveBeenCalledOnce();
    expect(fake.writer).toHaveBeenCalledTimes(2);
    expect(result.result.success).toBe(true);
    expect(result.logger.info.mock.calls.filter(([line]) => line.includes('"event":"l1_candidate_observer"'))).toEqual([]);
  });
  it("timeout allows the baseline writer once and cannot authorize a late rejection", async () => {
    let resolve!: (value: unknown) => void;
    let received!: CandidateObservationSnapshot;
    const observer = vi.fn((snapshot: CandidateObservationSnapshot) => {
      received = snapshot;
      return new Promise((done) => { resolve = done; });
    });
    const result = await run("dedup", observer, "shadow", 5);
    expect(result.result.storedCount).toBe(1);
    expect(fake.writer).toHaveBeenCalledTimes(2);
    expect(received.writeAuthorized).toBe(false);
    resolve(received.candidates.map((candidate) => ({ candidate_id: candidate.record_id, disposition: "reject", reason: "conflict", confidence: 1 })));
    await new Promise((done) => setTimeout(done, 0));
    expect(fake.writer).toHaveBeenCalledTimes(2);
    expect(fake.runner).toHaveBeenCalledOnce();
  });
  it("no candidates preserves the existing early return with no observer or writer", async () => {
    fake.runner.mockResolvedValue("[]");
    const observer = vi.fn();
    const result = await run("dedup", observer);
    expect(result.result.extractedCount).toBe(0);
    expect(observer).not.toHaveBeenCalled();
    expect(fake.writer).not.toHaveBeenCalled();
    expect(fake.dedup).not.toHaveBeenCalled();
  });
  it("does not observe twice if a later existing writer/logging error enters store-all fallback", async () => {
    // The original writer helper catches writer errors but its logger can throw.
    // Exercise that existing broad-catch route without changing its behavior.
    fake.writer.mockRejectedValueOnce(Error("existing writer failure"));
    const observer = vi.fn((snapshot: CandidateObservationSnapshot) => snapshot.candidates.map((candidate) => ({
      candidate_id: candidate.record_id, disposition: "baseline", reason: "unchanged", confidence: null,
    })));
    let warningCalls = 0;
    const result = await extractL1Memories({
      messages: [user], sessionKey: "original session", baseDir: "unused-fixture", config: {},
      logger: { info() {}, error() {}, warn() { if (++warningCalls === 1) throw Error("existing logger failure"); } },
      options: { llmRunner: { run: fake.runner }, candidateObserver: { mode: "shadow", observer } },
    });
    expect(result.storedCount).toBe(2);
    expect(fake.writer).toHaveBeenCalledTimes(3);
    expect(fake.dedup).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledOnce();
    expect(observer.mock.calls[0][0].path).toBe("dedup");
  });
  it("oversized extraction windows skip only observation and preserve the original writer", async () => {
    const observer = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await extractL1Memories({
      messages: Array.from({ length: 65 }, (_, index) => ({ ...user, id: `message-${index}` })),
      sessionKey: "original session", baseDir: "unused-fixture", config: {}, logger,
      options: { maxMessagesPerExtraction: 65, llmRunner: { run: fake.runner }, candidateObserver: { mode: "shadow", observer } },
    });
    expect(result.storedCount).toBe(1);
    expect(observer).not.toHaveBeenCalled();
    expect(fake.writer).toHaveBeenCalledTimes(2);
    expect(fake.runner).toHaveBeenCalledOnce();
    const events = logger.warn.mock.calls.filter(([line]) => line.includes('"event":"l1_candidate_observer"'));
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0][0]).reason).toBe("capacity");
  });
});
