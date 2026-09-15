import { describe, expect, it, vi } from "vitest";
import {
  CANDIDATE_OBSERVER_LIMITS as limits, observeExtractionCandidates, observationMessageWindow,
  type CandidateObservationInput, type CandidateObservationSnapshot,
  type CandidateObserver,
} from "./l1-candidate-observer.js";

function input(): CandidateObservationInput {
  return {
    path: "dedup",
    candidates: [{ record_id: "candidate-1", content: "sensitive candidate", type: "instruction", priority: 50, source_message_ids: ["source-1"], metadata: { activity_start_time: "2026-09-05" }, scene_name: "sensitive scene" }],
    decisions: [{ record_id: "candidate-1", action: "update", target_ids: ["sensitive-target"], merged_content: "original merge", merged_type: "instruction", merged_priority: 51, merged_timestamps: ["2026-09-05"] }],
    sourceMessages: [{ id: "source-1", role: "user", content: "sensitive message", timestamp: 1 }],
  };
}
function observations(snapshot: CandidateObservationSnapshot) {
  return snapshot.candidates.map((candidate) => ({ candidate_id: candidate.record_id, disposition: "baseline", reason: "unchanged", confidence: null }));
}
async function observe(createInput = input, observer: CandidateObserver = observations, timeoutMs = 100) {
  const logger = { info: vi.fn(), warn: vi.fn() };
  const result = await observeExtractionCandidates({ mode: "shadow", observer, timeoutMs }, createInput, logger);
  return { result, logger };
}
describe("existing L1 candidate shadow observer", () => {
  it("defaults off without touching input, callback, logger or sensitive getters", async () => {
    const create = vi.fn(() => { throw new Error("sensitive input must remain unread"); });
    const options = { get observer(): CandidateObserver { throw new Error("callback inspected"); } };
    const logger = { get info(): never { throw new Error("logger inspected"); }, get warn(): never { throw new Error("logger inspected"); } };
    expect((await observeExtractionCandidates(options, create, logger)).reason).toBe("off");
    expect((await observeExtractionCandidates(undefined, create, logger)).reason).toBe("off");
    expect((await observeExtractionCandidates({ mode: "off" }, create, logger)).reason).toBe("off");
    expect(create).not.toHaveBeenCalled();
  });
  it("copies all candidate/decision fields and freezes detached nested input", async () => {
    const original = input();
    const before = JSON.stringify(original);
    const { result } = await observe(() => original, (snapshot) => {
      expect(snapshot.candidates).toEqual(original.candidates);
      expect(snapshot.decisions).toEqual(original.decisions);
      expect(snapshot.sourceMessages).toEqual(original.sourceMessages);
      expect(snapshot.writeAuthorized).toBe(false);
      expect(snapshot.candidates[0]).not.toBe(original.candidates[0]);
      expect(Object.isFrozen(snapshot.candidates[0].metadata)).toBe(true);
      expect(Object.isFrozen(snapshot.decisions[0].target_ids)).toBe(true);
      expect(() => { (snapshot.candidates[0] as { content: string }).content = "changed"; }).toThrow();
      return observations(snapshot);
    });
    expect(result.reason).toBe("observed");
    expect(JSON.stringify(original)).toBe(before);
    expect(Object.isFrozen(result.observations[0])).toBe(true);
  });
  it("preserves one-to-many and many-to-one source alignment", async () => {
    const source = input();
    source.sourceMessages = [...source.sourceMessages, { id: "source-2", role: "assistant", content: "source two", timestamp: 2 }];
    source.candidates = [...source.candidates, { ...source.candidates[0], record_id: "candidate-2", source_message_ids: ["source-1", "source-2"] }];
    const { result } = await observe(() => source, (snapshot) => {
      expect(snapshot.candidates[1].source_message_ids).toEqual(["source-1", "source-2"]);
      expect(snapshot.decisions[1]).toEqual({ record_id: "candidate-2", action: "store", target_ids: [] });
      return observations(snapshot);
    });
    expect(result.observations).toHaveLength(2);
  });
  it("uses the writer's last raw decision and missing-decision store semantics", async () => {
    const source = input();
    source.decisions = [...source.decisions!, { record_id: "candidate-1", action: "skip", target_ids: [] }, { record_id: "irrelevant", action: "store", target_ids: [] }];
    expect((await observe(() => source, (snapshot) => {
      expect(snapshot.decisions).toHaveLength(1);
      expect(snapshot.decisions[0].action).toBe("skip");
      return observations(snapshot);
    })).result.reason).toBe("observed");
  });
  it("does not call the observer for an empty candidate batch", async () => {
    const observer = vi.fn();
    const { result, logger } = await observe(() => ({ path: "dedup_disabled", candidates: [], sourceMessages: [] }), observer);
    expect(result.reason).toBe("no_candidates");
    expect(observer).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledOnce();
  });
  it("rejects unknown source IDs and duplicate candidate IDs without an observation", async () => {
    for (const kind of ["source", "candidate"] as const) {
      const source = input();
      if (kind === "source") source.candidates[0].source_message_ids = ["not-observed"];
      else source.candidates = [...source.candidates, source.candidates[0]];
      const observer = vi.fn();
      expect((await observe(() => source, observer)).result.reason).toBe("invalid_input");
      expect(observer).not.toHaveBeenCalled();
    }
  });
  it.each(["missing", "unknown", "duplicate", "rewrite", "NaN", "range"])("rejects %s callback output, retaining baseline", async (kind) => {
    const { result } = await observe(input, (snapshot) => {
      const out = observations(snapshot);
      if (kind === "missing") return [];
      if (kind === "unknown") return [{ ...out[0], candidate_id: "other" }];
      if (kind === "duplicate") return [out[0], out[0]];
      if (kind === "rewrite") return [{ ...out[0], content: "replacement" }];
      return [{ ...out[0], confidence: kind === "NaN" ? NaN : 1.1 }];
    });
    expect(result.reason).toBe("invalid_output");
    expect(result.baselinePreserved).toBe(true);
    expect(result.observations).toEqual([]);
  });
  it("accepts shadow reject/defer only as detached observations, with no writer capability", async () => {
    const { result } = await observe(input, (snapshot) => {
      expect(Object.keys(snapshot).sort()).toEqual(["candidates", "decisions", "path", "sourceMessages", "writeAuthorized"]);
      return [{ candidate_id: snapshot.candidates[0].record_id, disposition: "reject", reason: "temporary", confidence: 0.9 }];
    });
    expect(result.reason).toBe("observed");
    expect(result.baselinePreserved).toBe(true);
    expect(result.observations[0].disposition).toBe("reject");
  });
  it("bounds candidates, source messages, raw decisions, targets, strings and total copied text", async () => {
    const variants = [
      () => ({ ...input(), candidates: Array.from({ length: limits.candidates + 1 }, () => input().candidates[0]) }),
      () => ({ ...input(), sourceMessages: Array.from({ length: limits.messages + 1 }, () => input().sourceMessages[0]) }),
      () => ({ ...input(), decisions: Array.from({ length: limits.decisions + 1 }, () => input().decisions![0]) }),
      () => { const value = input(); value.decisions![0].target_ids = Array(limits.targets + 1).fill("x"); return value; },
      () => { const value = input(); value.candidates[0].content = "中".repeat(3000); return value; },
      () => { const value = input(); value.sourceMessages = Array.from({ length: 16 }, (_, i) => ({ ...value.sourceMessages[0], id: `source-${i}`, content: "x".repeat(5000) })); return value; },
    ];
    for (const create of variants) {
      const observer = vi.fn();
      expect((await observe(create, observer)).result.reason).toBe("capacity");
      expect(observer).not.toHaveBeenCalled();
    }
  });
  it("rejects getters without invoking them, circular metadata and unsupported instances", async () => {
    let getterCalls = 0;
    const getter = { get activity_start_time() { getterCalls++; return "private"; } };
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const metadata of [getter, cycle, new Date()]) {
      const source = input();
      source.candidates[0].metadata = metadata as typeof source.candidates[number]["metadata"];
      expect((await observe(() => source)).result.reason).toBe("invalid_input");
    }
    expect(getterCalls).toBe(0);
  });
  it("logs a single safe aggregate without text, IDs, exception data or dispositions", async () => {
    const { result, logger } = await observe(input, () => { throw new Error("sensitive exception secret"); });
    expect(result.reason).toBe("observer_error");
    expect(logger.warn).toHaveBeenCalledOnce();
    const line = logger.warn.mock.calls[0][0] as string;
    expect(line.length).toBeLessThan(512);
    for (const secret of ["sensitive", "candidate-1", "source-1", "private", "secret", "original merge"]) expect(line).not.toContain(secret);
    expect(JSON.parse(line).actions).toEqual({ store: 0, update: 1, merge: 0, skip: 0 });
    const output = await observeExtractionCandidates({ mode: "shadow", observer: observations }, input, { info() { throw Error("broken"); }, warn() { throw Error("broken"); } });
    expect(output.reason).toBe("observed");
  });
  it("aborts on timeout, ignores late results, and keeps the callback busy until it settles", async () => {
    let resolve!: (value: unknown) => void;
    let snapshot!: CandidateObservationSnapshot;
    let signal!: AbortSignal;
    const observer = vi.fn((received, receivedSignal) => {
      snapshot = received; signal = receivedSignal;
      return new Promise((done) => { resolve = done; });
    });
    const { result, logger } = await observe(input, observer, 5);
    expect(result.reason).toBe("timeout");
    expect(signal.aborted).toBe(true);
    expect(snapshot.writeAuthorized).toBe(false);
    expect((await observe(input, observer, 5)).result.reason).toBe("busy");
    expect(observer).toHaveBeenCalledOnce();
    resolve(observations(snapshot));
    await new Promise((done) => setTimeout(done, 0));
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(result.observations).toEqual([]);
  });
  it("handles a rejection arriving after timeout without retry or an unhandled rejection", async () => {
    let reject!: (reason: unknown) => void;
    const observer = vi.fn(() => new Promise((_done, fail) => { reject = fail; }));
    expect((await observe(input, observer, 5)).result.reason).toBe("timeout");
    reject(Error("late private failure"));
    await new Promise((done) => setTimeout(done, 0));
    expect(observer).toHaveBeenCalledOnce();
  });
  it("caps in-flight callbacks globally, including timed-out tasks", async () => {
    const release: Array<(value: unknown) => void> = [];
    const pending = Array.from({ length: limits.inFlight }, () => () => new Promise((done) => { release.push(done); }));
    for (const observer of pending) expect((await observe(input, observer, 2)).result.reason).toBe("timeout");
    const create = vi.fn(input);
    const observer = vi.fn(observations);
    expect((await observe(create, observer)).result.reason).toBe("busy");
    expect(create).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled();
    for (const done of release) done([]);
    await new Promise((done) => setTimeout(done, 0));
    expect((await observe()).result.reason).toBe("observed");
  });
  it("rejects invalid configuration and missing callbacks before reading content", async () => {
    const create = vi.fn(input);
    for (const timeoutMs of [0, -1, 1.5, Infinity, limits.maxTimeoutMs + 1]) {
      expect((await observeExtractionCandidates({ mode: "shadow", observer: observations, timeoutMs }, create)).reason).toBe("invalid_configuration");
    }
    expect((await observeExtractionCandidates({ mode: "shadow" }, create)).reason).toBe("missing_observer");
    expect(create).not.toHaveBeenCalled();
  });
  it("bounds source windows before concatenation and leaves the original arrays untouched", () => {
    const background = input().sourceMessages;
    const recent = [{ ...background[0], id: "source-2" }];
    expect(observationMessageWindow(background, recent)).toEqual([...background, ...recent]);
    expect(background).toHaveLength(1);
    const tooLarge = Array(limits.messages + 1);
    Object.defineProperty(tooLarge, "concat", { get() { throw new Error("must not concatenate"); } });
    expect(() => observationMessageWindow(tooLarge, [])).toThrow("capacity");
  });
});
