import type { KnowledgeItem } from "../../../src/knowledge/core-client.js";

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

export function mockBridgeResponse(url: string, body: Record<string, unknown>): unknown {
  if (url.endsWith("/tools/list")) {
    const names = body.knowledge_id === "kg-wiki"
      ? ["search", "read_page"]
      : ["explore", "search", "node", "callers", "callees", "impact"];
    const parameter = (name: string) => name === "read_page" ? "page_id"
      : (["node", "callers", "callees"].includes(name) ? "symbol" : "query");
    return { code: 0, data: { tools: names.map((name) => ({
      name,
      params: { type: "object", properties: { [parameter(name)]: { type: "string" } }, required: [parameter(name)] },
    })) } };
  }
  if (url.endsWith("/tools/call") && body.knowledge_id === "kg-wiki" && body.tool_name === "search") {
    return { code: 0, data: { items: [{ page_id: "page-1", title: "Relevant design decision" }] } };
  }
  if (url.endsWith("/tools/call") && body.knowledge_id === "kg-wiki" && body.tool_name === "read_page") {
    return { code: 0, data: { page_id: "page-1", content: "Fixture design decision." } };
  }
  if (url.includes("/atomic/search")) return { code: 0, data: { items: [] } };
  if (url.includes("/conversation/search")) return { code: 0, data: { messages: [] } };
  return { code: 0, data: {} };
}
