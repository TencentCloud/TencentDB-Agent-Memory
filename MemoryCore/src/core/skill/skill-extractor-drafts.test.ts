import { describe, expect, it, vi } from "vitest";
import { SkillExtractor, createExtractorAdapter, type ExtractInput, type ExtractResult, type ExtractorRunner } from "./skill-extractor.js";
import { SKILL_REVIEW_PROMPT } from "./prompts/skill-review-prompt.js";
import { SKILL_REVIEW_PROMPT_STRICT } from "./prompts/skill-review-prompt-strict.js";
import { SKILL_DRAFT_PROTOCOL } from "./skill-draft-session.js";
import type { SkillCore } from "./skill-core.js";
import type { Skill } from "./types.js";
import type { SkillCandidateSubmission, SkillDraftBatch, SkillDraftPublisher, SkillRestructureOperation, SkillRestructureStatus } from "./skill-restructure-types.js";

vi.mock("../report/kafka-metric-producer.js", () => ({ metricProducer: { send: vi.fn() } }));
vi.mock("../report/trace.js", () => ({ trace: { report: vi.fn() } }));
vi.mock("../report/obs-logger.js", () => ({ obsLogger: { info: vi.fn(), warn: vi.fn() } }));

const BODY = "---\nname: safe-diagnosis\ndescription: Diagnose safely.\n---\n# Diagnose\nNever delete data without explicit approval.\n";
const INPUT: ExtractInput = { user_id: "actor", team_id: "team", agent_id: "agent", task_id: "task-1", messages: [{ role: "user", content: "Remember the repeatable diagnosis procedure." }] };
function core() {
  const source: Skill = { row_id: "row", skill_id: "skl-source", version: 3, is_head: true, user_id: "author", owner_agent_id: "agent", team_id: "team", task_id: "old-task", name: "safe-diagnosis", description: "Diagnose safely.", content: BODY, content_hash: "hash", manifest: [], storage_dir: "old", status: "active", metadata_json: '{"custom":true}', created_at_ms: 1, updated_at_ms: 2 };
  const write = vi.fn(async (): Promise<Skill> => { throw new Error("live writes forbidden"); });
  const value = { get: vi.fn(async () => source), list: vi.fn(async () => ({ items: [source], total: 1 })), search: vi.fn(async () => []), readFile: vi.fn(), create: write, update: write, patch: write, writeFiles: write };
  return { core: value as unknown as SkillCore, value, write, source };
}
function operation(candidate: SkillCandidateSubmission, status: SkillRestructureStatus = "succeeded"): SkillRestructureOperation {
  return { operation_id: `op-${candidate.request_id}`, status, source_skill_id: candidate.source?.skill_id ?? "draft:new", source_version: candidate.source?.expected_version ?? 0, created_at_ms: 1, updated_at_ms: 2, attempts: 1,
    outputs: status === "succeeded" ? [{ key: "root", skill_id: candidate.source?.skill_id ?? "skl-created", version: candidate.source ? 4 : 1, name: candidate.candidate.name, role: "root", reused: false }] : [],
    error: ["failed", "rejected", "conflict"].includes(status) ? { code: "EXPECTED_FAILURE", message: "Publisher refused the candidate" } : undefined };
}
function publisher(run: (candidate: SkillCandidateSubmission) => Promise<SkillRestructureOperation> = async c => operation(c)) {
  const batches = new Map<string, SkillDraftBatch>();
  const port: SkillDraftPublisher = {
    loadDraftBatch: vi.fn(async input => structuredClone(batches.get(input.request_id) ?? null)),
    freezeDraftBatch: vi.fn(async input => { if (!batches.has(input.request_id)) batches.set(input.request_id, structuredClone({ candidates: input.candidates })); return structuredClone(batches.get(input.request_id)!); }),
    runCandidate: vi.fn(run),
  };
  return { port, batches };
}
type RunInput = Parameters<ExtractorRunner["run"]>[0];
async function execute(params: RunInput, name: string, args: unknown): Promise<any> {
  const t = params.tools![name] as { execute: (args: unknown, context: unknown) => Promise<string> };
  return JSON.parse(await t.execute(args, { toolCallId: "test", messages: [] }));
}
function creatingRunner() {
  return { run: vi.fn(async (params: RunInput) => {
    const result = await execute(params, "skill_create", { name: "safe-diagnosis", content: BODY });
    expect(result.draft_id).toMatch(/^draft:/); expect(result.skill_id).toBeUndefined();
    return "Prepared safe-diagnosis.";
  }) };
}

describe("SkillExtractor private draft publication", () => {
  it("freezes complete drafts after normal runner completion and returns only actual root/child publication receipts", async () => {
    const c = core(); const p = publisher(async candidate => ({ ...operation(candidate), outputs: [
      { key: "root", skill_id: "skl-source", version: 4, name: "safe-diagnosis", role: "root", reused: false },
      { key: "child", skill_id: "skl-child", version: 1, name: "certificate-renewal", role: "child", reused: false },
      { key: "existing", skill_id: "skl-reused", version: 8, name: "shared-reference", role: "child", reused: true },
    ] }));
    const run: ExtractorRunner = { run: async params => {
      const opened = await execute(params, "skill_view", { skill_id: "skl-source" });
      expect(p.port.runCandidate).not.toHaveBeenCalled();
      await execute(params, "skill_update", { draft_id: opened.draft_id, expected_revision: 0, content: BODY + "Verify recovery." });
      expect(c.source.content).toBe(BODY); expect(p.port.freezeDraftBatch).not.toHaveBeenCalled();
      return "Prepared drafts.";
    } };
    const result = await new SkillExtractor({ core: c.core, runner: run, draftPublisher: p.port }).extract(INPUT);
    expect(result.candidates).toEqual([{ action: "update", skill_id: "skl-source", version: 4, name: "safe-diagnosis" }, { action: "create", skill_id: "skl-child", version: 1, name: "certificate-renewal" }]);
    expect(result.operations?.[0].status).toBe("succeeded"); expect(c.write).not.toHaveBeenCalled();
    const submitted = vi.mocked(p.port.runCandidate).mock.calls[0][0];
    expect(submitted).toMatchObject({ user_id: "actor", team_id: "team", agent_id: "agent", task_id: "task-1", source: { skill_id: "skl-source", expected_version: 3 }, candidate: { metadata: { custom: true } } });
  });
  it("does not freeze or publish anything when the runner fails after writing several private drafts", async () => {
    const c = core(); const p = publisher();
    const runner: ExtractorRunner = { run: async params => {
      await execute(params, "skill_create", { name: "safe-diagnosis", content: BODY });
      await execute(params, "skill_create", { name: "second-capability", content: BODY.replace("name: safe-diagnosis", "name: second-capability") });
      throw new Error("late runner failure");
    } };
    await expect(new SkillExtractor({ core: c.core, runner, draftPublisher: p.port }).extract(INPUT)).rejects.toThrow("late runner failure");
    expect(c.write).not.toHaveBeenCalled(); expect(p.port.freezeDraftBatch).not.toHaveBeenCalled(); expect(p.port.runCandidate).not.toHaveBeenCalled();
  });
  it("does not freeze a production batch after an auxiliary query runner fails", async () => {
    const c = core(); c.value.list.mockResolvedValue({ items: [c.source], total: 2 }); const p = publisher();
    let calls = 0;
    const runner: ExtractorRunner = { run: async params => {
      if (++calls === 1) throw new Error("query runner failed");
      await execute(params, "skill_create", { name: "safe-diagnosis", content: BODY }); return "prepared";
    } };
    await expect(new SkillExtractor({ core: c.core, runner, draftPublisher: p.port, prefixSkillsLimit: 1 }).extract(INPUT)).rejects.toThrow("query runner failed");
    expect(calls).toBe(1); expect(p.port.freezeDraftBatch).not.toHaveBeenCalled(); expect(p.port.runCandidate).not.toHaveBeenCalled();
  });
  it("resumes the frozen batch after publication interruption without another LLM or prefix query", async () => {
    const c = core(); let count = 0;
    const p = publisher(async candidate => { if (++count === 1) throw new Error("publisher unavailable"); return operation(candidate); });
    const run = creatingRunner();
    const extractor = new SkillExtractor({ core: c.core, runner: run, draftPublisher: p.port });
    await expect(extractor.extract(INPUT)).rejects.toMatchObject({ code: "SKILL_DRAFT_PUBLISH_RETRYABLE", retryable: true });
    const resumed = new SkillExtractor({ core: c.core, runner: { run: async () => { throw new Error("LLM must not run"); } }, draftPublisher: p.port, prefixSkillsLimit: 20 });
    const result = await resumed.extract(INPUT);
    expect(result.candidates[0].name).toBe("safe-diagnosis"); expect(run.run).toHaveBeenCalledTimes(1);
    expect(c.value.list).not.toHaveBeenCalled(); expect(p.port.freezeDraftBatch).toHaveBeenCalledTimes(1);
    const attempts = vi.mocked(p.port.runCandidate).mock.calls;
    expect(attempts[0][0]).toEqual(attempts[1][0]);
  });
  it("publishes the authoritative first frozen candidate set, not the losing local draft names", async () => {
    const c = core(); const p = publisher(); const run = creatingRunner();
    const winner: SkillCandidateSubmission = { ...INPUT, request_id: "candidate:winner", candidate: { name: "first-winner", content: BODY.replace("safe-diagnosis", "first-winner"), resources: [], metadata: {} } };
    vi.mocked(p.port.freezeDraftBatch).mockResolvedValue({ candidates: [winner] });
    const result = await new SkillExtractor({ core: c.core, runner: run, draftPublisher: p.port }).extract(INPUT);
    expect(vi.mocked(p.port.runCandidate).mock.calls[0][0].candidate.name).toBe("first-winner");
    expect(result.candidates[0].name).toBe("first-winner");
  });
  it.each(["failed", "rejected", "conflict"] as const)("preserves explicit %s operation information rather than claiming nothing to save", async status => {
    const c = core(); const p = publisher(async candidate => operation(candidate, status));
    const result = await new SkillExtractor({ core: c.core, runner: creatingRunner(), draftPublisher: p.port }).extract(INPUT);
    expect(result.candidates).toEqual([]); expect(result.operations?.[0]).toMatchObject({ status, error: { code: "EXPECTED_FAILURE" } });
    expect(result.text).toContain(status); expect(result.text).not.toBe("Nothing to save.");
  });
  it.each(["queued", "running", "prepared", "publishing"] as const)("throws a retryable operation-bearing error for %s publication", async status => {
    const c = core(); const p = publisher(async candidate => operation(candidate, status));
    await expect(new SkillExtractor({ core: c.core, runner: creatingRunner(), draftPublisher: p.port }).extract(INPUT)).rejects.toMatchObject({ code: "SKILL_DRAFT_PUBLISH_RETRYABLE", retryable: true, operations: [expect.objectContaining({ status })] });
  });
  it("does not emit candidates for unchanged operations", async () => {
    const c = core(); const p = publisher(async candidate => operation(candidate, "unchanged"));
    const result = await new SkillExtractor({ core: c.core, runner: creatingRunner(), draftPublisher: p.port }).extract(INPUT);
    expect(result.candidates).toEqual([]); expect(result.operations?.[0].status).toBe("unchanged");
  });
  it("hashes complete original messages, reason and mode rather than the truncated model prompt", async () => {
    const c = core(); const p = publisher(); const run = { run: vi.fn(async () => "Nothing to save.") };
    const extractor = new SkillExtractor({ core: c.core, runner: run, draftPublisher: p.port, headChars: 8, tailChars: 8 });
    const base = { ...INPUT, messages: [{ role: "user" as const, content: "prefix" + "x".repeat(200) + "ONE" + "z".repeat(200) + "suffix" }] };
    await extractor.extract(base); await extractor.extract(structuredClone(base));
    await extractor.extract({ ...base, messages: [{ role: "user", content: base.messages[0].content.replace("ONE", "TWO") }] });
    await extractor.extract({ ...base, reason: "new reason" });
    await extractor.extract({ ...base, mode: "strict" });
    expect(run.run).toHaveBeenCalledTimes(4);
    const requests = vi.mocked(p.port.freezeDraftBatch).mock.calls.map(([input]) => input);
    expect(new Set(requests.map(r => r.input_hash)).size).toBe(4); expect(new Set(requests.map(r => r.request_id)).size).toBe(4);
  });
  it.each(["runner", "finalize", "freeze"] as const)("does not flush private drafts when cancellation occurs during %s", async when => {
    const c = core(); const p = publisher(); const controller = new AbortController();
    if (when === "finalize") {
      c.source.manifest = [{ path: "references/check.md", size_bytes: 3, mime_type: "text/plain", is_executable: false }];
      c.value.readFile.mockImplementation(async () => { controller.abort(); return { path: "references/check.md", content: "YWJj", encoding: "base64", size_bytes: 3, mime_type: "text/plain", version: 3 }; });
    }
    if (when === "freeze") vi.mocked(p.port.freezeDraftBatch).mockImplementation(async batch => { controller.abort(); return { candidates: batch.candidates }; });
    const runner: ExtractorRunner = { run: async params => {
      expect(params.abortSignal).toBe(controller.signal); expect(params.signal).toBe(controller.signal);
      if (when === "finalize") await execute(params, "skill_view", { skill_id: "skl-source" });
      else await execute(params, "skill_create", { name: "safe-diagnosis", content: BODY });
      if (when === "runner") controller.abort();
      return "Prepared drafts.";
    } };
    await expect(new SkillExtractor({ core: c.core, runner, draftPublisher: p.port }).extract({ ...INPUT, abortSignal: controller.signal })).rejects.toMatchObject({ code: "SKILL_DRAFT_PUBLISH_RETRYABLE" });
    expect(p.port.runCandidate).not.toHaveBeenCalled(); expect(c.write).not.toHaveBeenCalled();
    if (when !== "freeze") expect(p.port.freezeDraftBatch).not.toHaveBeenCalled();
  });
  it("forwards cancellation to the publisher and stops before the next candidate", async () => {
    const c = core(); const controller = new AbortController();
    const p = publisher(async candidate => { controller.abort(); return operation(candidate); });
    const runner: ExtractorRunner = { run: async params => {
      await execute(params, "skill_create", { name: "safe-diagnosis", content: BODY });
      await execute(params, "skill_create", { name: "another-capability", content: BODY.replace("name: safe-diagnosis", "name: another-capability") });
      return "Prepared two drafts.";
    } };
    await expect(new SkillExtractor({ core: c.core, runner, draftPublisher: p.port }).extract({ ...INPUT, abortSignal: controller.signal })).rejects.toMatchObject({ code: "SKILL_DRAFT_PUBLISH_RETRYABLE", operations: [expect.objectContaining({ status: "succeeded" })] });
    expect(p.port.runCandidate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(p.port.runCandidate).mock.calls[0][1]).toBe(controller.signal);
  });
  it("passes abortSignal and explicit operation/text receipts through the worker adapter", async () => {
    const controller = new AbortController();
    const receipt = operation({ request_id: "candidate:adapter", candidate: { name: "safe-diagnosis", content: BODY, resources: [] } }, "rejected");
    const extract = vi.fn(async (): Promise<ExtractResult> => ({ candidates: [], operations: [receipt], text: "Rejected by semantic review" }));
    const adapter = createExtractorAdapter({ extract } as unknown as SkillExtractor);
    const request = { team_id: "team", user_id: "actor", agent_id: "agent", task_id: "task", conversation: INPUT.messages, abortSignal: controller.signal };
    const result = await adapter.extract(request) as ExtractResult;
    expect(extract).toHaveBeenCalledWith(expect.objectContaining({ abortSignal: controller.signal }));
    expect(result.operations).toEqual([receipt]); expect(result.text).toContain("Rejected");
  });
  it("freezes no candidates for protected reads rather than treating the read itself as forbidden", async () => {
    const c = core(); c.source.metadata_json = '{"protected":true}'; const p = publisher();
    const runner: ExtractorRunner = { run: async params => {
      const opened = await execute(params, "skill_view", { skill_id: "skl-source" });
      expect(opened.read_only).toBe(true); expect(opened.content).toBe(BODY); return "Nothing to save.";
    } };
    const result = await new SkillExtractor({ core: c.core, runner, draftPublisher: p.port }).extract(INPUT);
    expect(result.candidates).toEqual([]); expect(p.port.runCandidate).not.toHaveBeenCalled();
    expect(vi.mocked(p.port.freezeDraftBatch).mock.calls[0][0].candidates).toEqual([]);
  });
  it.each(["default", "strict"] as const)("uses only the private protocol with the %s acceptance policy", async mode => {
    const c = core(), p = publisher();
    const run = creatingRunner();
    await new SkillExtractor({ core: c.core, runner: run, draftPublisher: p.port,
      systemPrompt: SKILL_REVIEW_PROMPT, strictSystemPrompt: SKILL_REVIEW_PROMPT_STRICT }).extract({ ...INPUT, mode });
    const prompt = run.run.mock.calls[0][0].systemPrompt!;
    expect(prompt).toContain("draft_id"); expect(prompt).toContain("expected_revision"); expect(prompt).toContain("base_version");
    expect(prompt).toContain("skill_files_read"); expect(prompt).not.toContain("automatically externalized losslessly");
    expect(prompt).not.toContain("requires `expected_version`");
    expect(prompt).not.toContain("Writes publish immediately");
    expect(prompt.split(SKILL_DRAFT_PROTOCOL)).toHaveLength(2);
    expect(prompt).toContain(mode === "strict" ? "total score is at least 72" : "default to capturing it");
    if (mode === "strict") expect(prompt).toContain("Only candidates classified as Skill");
  });
  it.each(["default", "strict"] as const)("uses only the live-write protocol with the %s acceptance policy when no publisher is bound", async mode => {
    const c = core(); c.value.update.mockImplementation(async () => c.source);
    const runner: ExtractorRunner = { run: async params => {
      expect(params.systemPrompt).toContain("expected_version");
      expect(params.systemPrompt).not.toContain("draft_id");
      expect(params.systemPrompt).not.toContain("expected_revision");
      expect(params.systemPrompt).not.toContain("prepare private drafts");
      expect(params.systemPrompt).not.toContain(SKILL_DRAFT_PROTOCOL);
      expect(params.systemPrompt).toContain(mode === "strict" ? "total score is at least 72" : "default to capturing it");
      const source = await execute(params, "skill_view", { skill_id: "skl-source" });
      expect(source.draft_id).toBeUndefined();
      const written = await execute(params, "skill_update", { skill_id: source.skill_id, expected_version: source.version, content: BODY });
      expect(written).toMatchObject({ ok: true, version: 3 });
      return "Updated safe-diagnosis.";
    } };
    const result = await new SkillExtractor({ core: c.core, runner, systemPrompt: SKILL_REVIEW_PROMPT,
      strictSystemPrompt: SKILL_REVIEW_PROMPT_STRICT }).extract({ ...INPUT, mode });
    expect(result.candidates).toMatchObject([{ action: "update", skill_id: "skl-source", version: 3 }]);
    expect(result.operations).toBeUndefined();
  });
  it.each([false, true])("preserves custom acceptance prompts and strict fallback with private mode=%s", async privateMode => {
    const c = core(), p = publisher();
    const custom = "Review only PostgreSQL backup procedures and preserve the user's language.";
    const run = { run: vi.fn(async (_params: RunInput) => "Nothing to save.") };
    await new SkillExtractor({ core: c.core, runner: run, systemPrompt: custom,
      draftPublisher: privateMode ? p.port : undefined }).extract({ ...INPUT, mode: "strict" });
    const prompt = run.run.mock.calls[0][0].systemPrompt!;
    expect(prompt.startsWith(custom)).toBe(true);
    expect(prompt).not.toContain("total score is at least 72");
    expect(prompt).toContain(privateMode ? "expected_revision" : "expected_version");
    if (!privateMode) expect(prompt).not.toContain(SKILL_DRAFT_PROTOCOL);
  });
  it("does not append a second private protocol to a custom prompt that already includes it", async () => {
    const c = core(), p = publisher();
    const custom = `Keep the organization's acceptance policy.\n\n${SKILL_DRAFT_PROTOCOL}`;
    const run = { run: vi.fn(async (_params: RunInput) => "Nothing to save.") };
    await new SkillExtractor({ core: c.core, runner: run, systemPrompt: custom, draftPublisher: p.port }).extract(INPUT);
    expect(run.run.mock.calls[0][0].systemPrompt).toBe(custom);
  });
  it("retains legacy construction without claiming draft or semantic publication support", async () => {
    const c = core(); c.value.create.mockImplementation(async () => c.source);
    const runner: ExtractorRunner = { run: async params => { await execute(params, "skill_create", { name: "safe-diagnosis", content: BODY }); return "created"; } };
    const result = await new SkillExtractor({ core: c.core, runner }).extract(INPUT);
    expect(c.write).toHaveBeenCalledTimes(1); expect(result.candidates[0].skill_id).toBe("skl-source"); expect(result.operations).toBeUndefined();
  });
});
