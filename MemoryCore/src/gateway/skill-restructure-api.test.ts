import { beforeEach, describe, expect, it, vi } from "vitest";
import * as handlers from "./skill-handlers.js";
import * as schemas from "./skill-schemas.js";
import type { SkillRouterDeps } from "./skill-handlers.js";
import type { SkillRestructureService } from "../core/skill/skill-restructure-service.js";
import type { SkillCore } from "../core/skill/skill-core.js";

vi.mock("../core/report/obs-logger.js", () => ({ obsLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../core/report/trace.js", () => ({ trace: { report: vi.fn() } }));
vi.mock("../core/report/kafka-metric-producer.js", () => ({ metricProducer: { send: vi.fn() } }));

const ids = { user_id: "user", team_id: "team", agent_id: "agent", task_id: "task" };
const auth = { serviceId: "instance-a", apiKey: "test-key" };
const operation = { operation_id: `sro-${"a".repeat(32)}`, status: "queued" as const, source_skill_id: "skl-source", source_version: 3,
  created_at_ms: 1, updated_at_ms: 1, attempts: 0, outputs: [] };
const candidate = { name: "guide", content: "---\nname: guide\ndescription: Guide\n---\n\n" + "large body ".repeat(6000),
  resources: [{ path: "binary", encoding: "base64" as const, content: "AP8=", mime_type: "application/octet-stream", is_executable: true }], metadata: { user: "keep" } };
const request = { ...ids, request_id: "stable-intent", skill_id: "skl-source", expected_version: 3, reason: "separate responsibilities" };

describe("explicit semantic restructure HTTP boundary (service stub, not model validation)", () => {
  const service = { start: vi.fn(), submitCandidate: vi.fn(), get: vi.fn() };
  let deps: SkillRouterDeps;
  beforeEach(() => {
    service.start.mockReset().mockResolvedValue(operation);
    service.submitCandidate.mockReset().mockResolvedValue({ ...operation, source_version: 0 });
    service.get.mockReset().mockResolvedValue(operation);
    deps = { getSkillCore: vi.fn(), resolveSkillRestructure: vi.fn(async () => service as unknown as SkillRestructureService),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
  });

  it("registers both POST handler paths without changing existing CRUD routes", () => {
    const routes = handlers.makeSkillRouteTable();
    expect(routes["/v3/skill/restructure"]).toBeTypeOf("function");
    expect(routes["/v3/skill/restructure/get"]).toBeTypeOf("function");
    expect(routes["/v3/skill/create"]).toBe(handlers.handleCreate);
  });

  it("returns a queued operation, preserving the business request id separately from the HTTP trace id", async () => {
    const envelope = await handlers.handleRestructure(request, auth, "http-trace", deps);
    expect(envelope).toEqual({ code: 0, message: "ok", request_id: "http-trace", data: operation });
    expect(service.start).toHaveBeenCalledWith(request, undefined);
    expect(deps.resolveSkillRestructure).toHaveBeenCalledWith("instance-a");
    expect(deps.getSkillCore).not.toHaveBeenCalled();
    expect(service.submitCandidate).not.toHaveBeenCalled();
    expect(envelope.data).not.toHaveProperty("version");
  });

  it("submits the complete explicit candidate with force true, without publishing CRUD directly", async () => {
    const input = { ...ids, request_id: "candidate-intent", candidate, source: { skill_id: "skl-source", expected_version: 3 } };
    const envelope = await handlers.handleRestructure(input, auth, "http-trace", deps);
    expect(envelope.code).toBe(0);
    expect(service.submitCandidate).toHaveBeenCalledWith({ ...input, force: true }, undefined);
    expect(service.start).not.toHaveBeenCalled();
    expect(deps.getSkillCore).not.toHaveBeenCalled();
    await handlers.handleRestructure({ ...ids, request_id: "new-candidate", candidate }, auth, "trace-2", deps);
    expect(service.submitCandidate.mock.calls[1][0]).toEqual({ ...ids, request_id: "new-candidate", candidate, force: true });
  });

  it("applies the existing write quota before a new explicit operation is accepted", async () => {
    const checkMemoryQuota = vi.fn(async () => ({ allowed: false, current: 10, limit: 10 }));
    deps.quotaManager = { checkMemoryQuota } as unknown as NonNullable<SkillRouterDeps["quotaManager"]>;
    const accepted = vi.fn();
    const submit = async (_input: unknown, beforeSubmit?: () => Promise<void>) => {
      await beforeSubmit?.(); accepted(); return operation;
    };
    service.start.mockImplementation(submit);
    service.submitCandidate.mockImplementation(submit);
    for (const input of [request, { ...ids, request_id: "candidate", candidate }]) {
      expect(await handlers.handleRestructure(input, auth, "trace", deps))
        .toMatchObject({ code: 4291, message: "Memory limit exceeded (current=10, limit=10)" });
    }
    expect(checkMemoryQuota.mock.calls).toEqual([["instance-a", 1], ["instance-a", 1]]);
    expect(accepted).not.toHaveBeenCalled();
  });

  it("allows replay and status reads without charging the new-submission quota again", async () => {
    const checkMemoryQuota = vi.fn(async () => ({ allowed: false, current: 10, limit: 10 }));
    deps.quotaManager = { checkMemoryQuota } as unknown as NonNullable<SkillRouterDeps["quotaManager"]>;
    // A service returns an existing intent before invoking its new-submission guard.
    service.start.mockResolvedValue(operation);
    expect((await handlers.handleRestructure(request, auth, "trace", deps)).data).toEqual(operation);
    expect((await handlers.handleRestructureGet({ ...ids, operation_id: operation.operation_id }, auth, "trace", deps)).data).toEqual(operation);
    expect(checkMemoryQuota).not.toHaveBeenCalled();
  });

  it("passes identity and instance isolation into operation reads", async () => {
    service.get.mockImplementation(async input => {
      if (input.team_id !== ids.team_id || input.user_id !== ids.user_id || input.agent_id !== ids.agent_id) {
        throw Object.assign(new Error("Operation not found"), { code: "SKILL_OPERATION_NOT_FOUND" });
      }
      return operation;
    });
    expect((await handlers.handleRestructureGet({ ...ids, operation_id: operation.operation_id }, auth, "get-trace", deps)).data).toEqual(operation);
    expect(service.get).toHaveBeenCalledWith({ ...ids, operation_id: operation.operation_id });
    for (const override of [{ team_id: "other" }, { user_id: "other" }, { agent_id: "other" }]) {
      expect((await handlers.handleRestructureGet({ ...ids, ...override, operation_id: operation.operation_id }, auth, "get-trace", deps)).code).toBe(40401);
    }
  });

  it.each([
    { ...request, candidate },
    { ...request, source: { skill_id: "other", expected_version: 1 } },
    { ...ids, request_id: "intent", candidate, expected_version: 3 },
    { ...ids, request_id: "intent", candidate, skill_id: "skl-source" },
    { ...ids, request_id: "intent", candidate, force: false },
    { ...ids, request_id: "intent", candidate, source: { skill_id: "skl-source" } },
    { ...ids, request_id: "intent", candidate: { ...candidate, resources: undefined } },
    { ...ids, request_id: "intent" },
    { ...request, request_id: undefined },
    { ...request, request_id: " " },
    { ...request, request_id: "a\0b" },
    { ...request, request_id: "x".repeat(257) },
    { ...request, expected_version: 0 },
    { ...request, expected_version: 1.5 },
    { ...request, team_id: undefined },
  ])("rejects ambiguous or invalid input case %# before resolving the service", async input => {
    const envelope = await handlers.handleRestructure(input, auth, "http-trace", deps);
    expect(envelope.code).toBe(40001);
    expect(deps.resolveSkillRestructure).not.toHaveBeenCalled();
    expect(service.start).not.toHaveBeenCalled();
    expect(service.submitCandidate).not.toHaveBeenCalled();
  });

  it("reuses optional identity rules and does not tighten ordinary CRUD", () => {
    expect(schemas.restructureRequestSchema.safeParse({ request_id: "stable", skill_id: "skl-source", expected_version: 1 }).success).toBe(true);
    expect(schemas.restructureGetRequestSchema.safeParse({ operation_id: operation.operation_id, agent_id: "a" }).success).toBe(false);
    expect(schemas.createRequestSchema.safeParse({ name: "guide", content: "legacy", ignored_legacy_field: true }).success).toBe(true);
  });

  it("does not generate an id or fall back to a global service when an instance is unavailable", async () => {
    deps.resolveSkillRestructure = undefined;
    expect((await handlers.handleRestructure(request, auth, "trace", deps)).code).toBe(50301);
    deps.resolveSkillRestructure = vi.fn(async () => undefined);
    expect((await handlers.handleRestructureGet({ ...ids, operation_id: operation.operation_id }, auth, "trace", deps)).code).toBe(50301);
    expect(deps.getSkillCore).not.toHaveBeenCalled();
  });

  it.each([
    ["SKILL_OPERATION_NOT_FOUND", 40401], ["SKILL_NOT_FOUND", 40401], ["SKILL_NOT_OWNER", 40301],
    ["SKILL_TEAM_MISMATCH", 40302], ["SKILL_PROTECTED", 40303], ["SKILL_VERSION_STALE", 40901],
    ["SKILL_MUTATION_CONFLICT", 40902], ["SKILL_PUBLICATION_BUSY", 40903], ["SKILL_RESTRUCTURE_DISABLED", 50301],
    ["SKILL_PUBLICATION_UNKNOWN", 50301], ["SKILL_PUBLICATION_COORDINATOR_REQUIRED", 50301], ["RESOURCE_INTEGRITY_ERROR", 50301],
    ["SKILL_FRONTMATTER_INVALID", 42203], ["RESOURCE_TOO_LARGE", 41301],
  ])("maps service/publication %s consistently to envelope %i", async (code, expected) => {
    service.start.mockRejectedValue(Object.assign(new Error(code), { code }));
    expect((await handlers.handleRestructure(request, auth, "trace", deps)).code).toBe(expected);
  });

  it.each(["ASSET_REGISTRATION_PENDING", "SKILL_ASSET_REGISTRATION_PENDING"])("reports %s as committed but awaiting asset registration, without rollback", async code => {
    const update = vi.fn().mockRejectedValue(Object.assign(new Error("Version committed; asset registration pending"), { code }));
    const rollback = vi.fn();
    deps.getSkillCore = () => ({ update, delete: rollback }) as unknown as SkillCore;
    const envelope = await handlers.handleUpdate({ ...ids, skill_id: "skl-source", expected_version: 3, content: "body" }, auth, "trace", deps);
    expect(envelope.code).toBe(50301);
    expect(envelope.data).toMatchObject({ error_code: code, publication_committed: true });
    expect(rollback).not.toHaveBeenCalled();
  });

  it("reports unfinished deletion cleanup as retryable service unavailability", async () => {
    const remove = vi.fn().mockRejectedValue(Object.assign(new Error("Deletion cleanup is pending"), { code: "SKILL_DELETION_PENDING" }));
    deps.getSkillCore = () => ({ delete: remove }) as unknown as SkillCore;
    expect(await handlers.handleDelete({ ...ids, skill_id: "skl-source" }, auth, "trace", deps))
      .toMatchObject({ code: 50301, message: "Deletion cleanup is pending", request_id: "trace" });
  });

  it("maps resolver errors and unknown failures without losing the envelope trace id", async () => {
    deps.resolveSkillRestructure = vi.fn(async () => { throw Object.assign(new Error("disabled"), { code: "SKILL_RESTRUCTURE_DISABLED" }); });
    expect(await handlers.handleRestructure(request, auth, "trace", deps)).toMatchObject({ code: 50301, request_id: "trace" });
    deps.resolveSkillRestructure = vi.fn(async () => { throw new Error("unexpected"); });
    expect(await handlers.handleRestructureGet({ ...ids, operation_id: operation.operation_id }, auth, "trace", deps)).toMatchObject({ code: 50001, request_id: "trace" });
  });
});
