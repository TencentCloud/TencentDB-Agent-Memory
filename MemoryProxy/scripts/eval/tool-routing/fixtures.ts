import type { KnowledgeItem } from "../../../src/knowledge/core-client.js";
import type { EvalCase, EvalKnowledgeResource, ParsedCall } from "./types.js";
import { matchRequestGuards } from "./request-guards.js";

export const FIXTURE = {
  proxyBaseUrl: "https://proxy.test",
  sessionId: "session-1",
  spaceId: "space-1",
  userId: "user-1",
  teamId: "team-1",
  agentId: "agent-1",
  listing: `<available_skills>
- pdf-workflow: Read and validate PDF files
- frontend-testing: Test rendered web applications
- spreadsheet-analysis: Analyze workbook data
</available_skills>`,
} as const;

export const KNOWLEDGE_FIXTURES: KnowledgeItem[] = [
  {
    knowledge_id: "kg-code",
    type: "code-graph",
    service_url: "https://knowledge.test/v3",
    name: "Proxy code graph",
    summary: "10 files",
    team_id: FIXTURE.teamId,
    user_id: null,
    repo_url: "git@example.test:acme/proxy.git",
    branch: "main",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
  {
    knowledge_id: "kg-wiki",
    type: "wiki",
    service_url: "https://knowledge.test/v3",
    name: "Architecture decisions",
    summary: "Design background and trade-offs",
    team_id: FIXTURE.teamId,
    user_id: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
];

const notFound = () => ({ code: 40401, message: "Requested resource was not found" });
const invalidRequest = () => ({ code: 40001, message: "Unsupported tool or invalid parameters" });
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

function knowledgeTools(resource: EvalKnowledgeResource) {
  const names = resource.type === "wiki" ? ["search", "read_page"]
    : ["explore", "search", "node", "callers", "callees", "impact"];
  return names.map((name) => {
    const parameter = name === "read_page" ? "page_id"
      : (["node", "callers", "callees"].includes(name) ? "symbol" : "query");
    return { name, params: { type: "object", properties: { [parameter]: { type: "string" } }, required: [parameter] } };
  });
}

/** Validate the advertised asset and API, independently of evaluator labels. */
function knowledgeRequestError(url: string, body: Record<string, unknown>, resources: EvalKnowledgeResource[]) {
  const resource = resources.find((item) => item.knowledge_id === body.knowledge_id);
  if (!resource || ![`${resource.service_url.replace(/\/$/, "")}/tools/list`,
    `${resource.service_url.replace(/\/$/, "")}/tools/call`].includes(url)) return notFound();
  if (url.endsWith("/tools/list")) return undefined;
  const tool = knowledgeTools(resource).find((item) => item.name === body.tool_name);
  const params = body.params;
  if (!tool || !params || typeof params !== "object" || Array.isArray(params)
    || !tool.params.required.every((key) => nonEmptyString((params as Record<string, unknown>)[key]))) return invalidRequest();
  return undefined;
}

export function mockBridgeResponse(
  url: string, body: Record<string, unknown>, resources: EvalKnowledgeResource[] = KNOWLEDGE_FIXTURES,
): unknown {
  if (url.endsWith("/tools/list") || url.endsWith("/tools/call")) {
    const error = knowledgeRequestError(url, body, resources);
    if (error) return error;
    const resource = resources.find((item) => item.knowledge_id === body.knowledge_id)!;
    if (url.endsWith("/tools/list")) return { code: 0, data: { tools: knowledgeTools(resource) } };
    if (["search", "explore", "callers", "callees"].includes(body.tool_name as string)) {
      return { code: 0, data: { items: [] } };
    }
    return notFound();
  }
  if (url.includes("/atomic/search")) return { code: 0, data: { items: [] } };
  if (url.includes("/conversation/search")) return { code: 0, data: { messages: [] } };
  if (url.endsWith("/skill/search")) return { code: 0, data: { items: [] } };
  if (url.endsWith("/skill/extract")) return { code: 0, data: { status: "accepted", task_id: "fixture-extraction" } };
  if (url.includes("/atomic/query")) return { code: 0, data: { items: [], has_more: false } };
  return notFound();
}

/** body_match specifies a subset, so property order and extra valid parameters do not change asset identity. */
function matches(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    return Boolean(actual && typeof actual === "object" && !Array.isArray(actual))
      && Object.entries(expected).every(([key, value]) => Object.hasOwn(actual as object, key)
        && matches((actual as Record<string, unknown>)[key], value));
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/** Parameterized asset reads, independent of required/allowed routes or scores. */
function responseForCall(response: unknown, call: ParsedCall): unknown {
  const envelope = response as { code?: number; data?: Record<string, any> } | undefined;
  if (envelope?.code !== 0 || !envelope.data) return response;
  const data = envelope.data, body = call.body ?? {};
  if (call.family === "memory" && call.tool === "tdai_atomic_query" && Array.isArray(data.items)) {
    const offset = body.offset ?? 0, limit = body.limit ?? 20;
    if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(limit) || (limit as number) <= 0
      || (body.type !== undefined && !nonEmptyString(body.type))) return invalidRequest();
    const start = body.time_start === undefined ? -Infinity : typeof body.time_start === "string" ? Date.parse(body.time_start) : NaN;
    const end = body.time_end === undefined ? Infinity : typeof body.time_end === "string" ? Date.parse(body.time_end) : NaN;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end) return invalidRequest();
    const rows = data.items.filter((item: Record<string, unknown>) => {
      if (body.type !== undefined && item.type !== body.type) return false;
      const created = typeof item.created_at === "string" ? Date.parse(item.created_at) : NaN;
      return (start === -Infinity && end === Infinity) || (!Number.isNaN(created) && created >= start && created < end);
    }).sort((a: Record<string, string>, b: Record<string, string>) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const items = rows.slice(offset as number, (offset as number) + (limit as number));
    return { code: 0, data: { items, total: rows.length, has_more: (offset as number) + items.length < rows.length } };
  }
  if (call.family === "knowledge") {
    const params = body.params as Record<string, unknown> | undefined;
    const query = typeof params?.query === "string" ? params.query.toLowerCase() : "";
    const tokens = query.split(/[^\p{L}\p{N}_]+/u).filter((token) => token.length >= 3);
    const relevant = (item: Record<string, unknown>) => typeof item.symbol === "string"
      && (query.includes(item.symbol.toLowerCase()) || tokens.some((token) => (item.symbol as string).toLowerCase().includes(token)));
    if (call.tool === "search" && Array.isArray(data.items) && data.items.length > 0
      && data.items.every((item: Record<string, unknown>) => typeof item.symbol === "string")) {
      return { code: 0, data: { ...data, items: data.items.filter(relevant) } };
    }
    if (call.tool === "impact" && Array.isArray(data.symbol_results)) {
      const found = data.symbol_results.filter(relevant);
      if (found.length > 1) return invalidRequest();
      return found.length === 1 ? { code: 0, data: found[0] } : notFound();
    }
  }
  return response;
}

/** Stateful, declarative mock used by multi-hop cases. */
export function createMockBridge(testCase: EvalCase): {
  handle(call: ParsedCall): unknown;
  completedStepIds(): string[];
} {
  const completed = new Set<string>();
  const steps = testCase.mock_steps ?? [];
  const resources = testCase.knowledge_resources ?? KNOWLEDGE_FIXTURES;
  return {
    handle(call: ParsedCall): unknown {
      if (call.family === "knowledge" && call.url && call.body) {
        const error = knowledgeRequestError(call.url, call.body, resources);
        if (error) return error;
      }
      const candidates = steps.filter((step) => {
        if (step.family !== call.family || step.tool !== call.tool) return false;
        const guard = matchRequestGuards(call.body ?? {}, step.request_guards);
        if (!matches(guard.normalized_body, step.body_match ?? {})) return false;
        if (step.request_guards?.length) {
          const { normalized_body: _, ...diagnostic } = guard;
          (call.fixture_guard_checks ??= []).push({ step_id: step.id, ...diagnostic });
        }
        return guard.status === "match";
      });
      const eligible = candidates.find((step) => !completed.has(step.id)
        && (step.requires ?? []).every((requirement) => completed.has(requirement)));
      if (eligible) {
        completed.add(eligible.id);
        call.fixture_step_id = eligible.id;
        return responseForCall(eligible.response, call);
      }
      const blocked = candidates.find((step) => !completed.has(step.id));
      if (blocked) {
        return { code: 40901, message: "The requested resource is not available in the current state" };
      }
      const repeated = candidates.at(-1);
      if (repeated) {
        call.fixture_step_id = repeated.id;
        return responseForCall(repeated.response, call);
      }
      if (call.url && call.body) return mockBridgeResponse(call.url, call.body, resources);
      return { code: 40001, message: call.error ?? "invalid mock request" };
    },
    completedStepIds(): string[] {
      return [...completed];
    },
  };
}
