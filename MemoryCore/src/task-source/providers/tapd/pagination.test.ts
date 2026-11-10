import { afterEach, describe, expect, it, vi } from "vitest";
import { tapdProvider } from "./index.js";
import { TapdMcpClient } from "./mcp-client.js";
import type { TaskSourceContext } from "../../types.js";

const ctx: TaskSourceContext = {
  endpoint: "https://tapd.example.invalid/mcp",
  siteBaseUrl: "https://tapd.example.invalid",
  cred: { kind: "bearer", secret: "test-only-token" },
};

function mockTapd(counts: number[], stringCount = false) {
  const tools = ["stories_get", "tasks_get", "bugs_get"];
  const data = Object.fromEntries(tools.map((tool, i) => [tool,
    Array.from({ length: counts[i] ?? 0 }, (_, n) => ({
      id: `${i}-${n + 1}`, name: `Item ${n + 1}`, title: `Bug ${n + 1}`,
    })),
  ]));
  const call = vi.spyOn(TapdMcpClient.prototype, "callRaw").mockImplementation(async (tool, args) => {
    if (tool === "tapd_field_detail_get") return { status: { options: {} } };
    const todo = tool.startsWith("user_todo_");
    const rows = data[todo ? tool.slice("user_todo_".length) : tool];
    if (!rows) throw new Error(`Unexpected tool: ${tool}`);
    if (todo) {
      expect(args).toEqual({ workspace_id: "test" });
      return rows;
    }
    const limit = Number(args.limit);
    const page = Number(args.page);
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThanOrEqual(200);
    const start = (page - 1) * limit;
    return { count: stringCount ? String(rows.length) : rows.length, data: rows.slice(start, start + limit) };
  });
  return { call, expected: Object.values(data).flat().map(row => row.id) };
}

afterEach(() => vi.restoreAllMocks());

describe("TAPD candidate pagination", () => {
  it.each([[4, 4, 0], [1, 5, 3], [0, 3, 0], [0, 0, 0], [260, 3, 2]])(
    "returns every item once for counts %j/%j/%j", async (stories, tasks, bugs) => {
      const { expected } = mockTapd([stories, tasks, bugs]);
      const limit = 2;
      const collected: string[] = [];
      const pages = Math.ceil(expected.length / limit);
      for (let page = 1; page <= pages + 1; page++) {
        const result = await tapdProvider.listCandidates(ctx, { scope: "test", page, limit });
        expect(result.total).toBe(expected.length);
        expect(result.hasMore).toBe(page * limit < expected.length);
        expect(result.items.map(item => item.externalId)).toEqual(expected.slice((page - 1) * limit, page * limit));
        collected.push(...result.items.map(item => item.externalId));
      }
      expect(collected).toEqual(expected);
    },
  );

  it("keeps single-type deep pagination as one list request", async () => {
    const { call } = mockTapd([260, 0, 0]);
    const result = await tapdProvider.listCandidates(ctx, { scope: "test", itemTypes: ["story"], page: 11, limit: 20 });
    expect(result.items.map(item => item.externalId)).toEqual(Array.from({ length: 20 }, (_, i) => `0-${201 + i}`));
    expect(result.total).toBe(260);
    expect(result.hasMore).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("supports deep multi-type pages with bounded requests", async () => {
    const { call } = mockTapd([260, 40, 0], true);
    const result = await tapdProvider.listCandidates(ctx, { scope: "test", page: 11, limit: 20 });
    expect(result.items.map(item => item.externalId)).toEqual(Array.from({ length: 20 }, (_, i) => `0-${201 + i}`));
    expect(result.total).toBe(300);
    expect(result.hasMore).toBe(true);
    // Deep pages must not require fetching every preceding page.
    expect(call.mock.calls.filter(([tool]) => tool.endsWith("s_get")).length).toBeLessThanOrEqual(6);
  });

  it("preserves filters on follow-up requests and honors requested type order", async () => {
    const { call } = mockTapd([4, 0, 1]);
    const result = await tapdProvider.listCandidates(ctx, {
      scope: "test", itemTypes: ["bug", "story"], page: 2, limit: 2,
      keyword: "needle", owner: "alice", status: "new",
    });
    expect(result.items.map(item => item.externalId)).toEqual(["0-2", "0-3"]);
    for (const [tool, args] of call.mock.calls) {
      if (tool === "tapd_field_detail_get") continue;
      expect(args).toMatchObject({ workspace_id: "test", status: "new", limit: 2 });
      expect(args).toMatchObject(tool === "bugs_get"
        ? { title: "needle", current_owner: "alice" }
        : { name: "needle", owner: "alice", with_v_status: "1" });
      if (tool === "bugs_get") expect(args).not.toHaveProperty("with_v_status");
    }
  });

  it("keeps todo pagination local without sending unsupported arguments", async () => {
    mockTapd([1, 3, 1]);
    const result = await tapdProvider.listCandidates(ctx, { scope: "test", onlyTodo: true, page: 2, limit: 2 });
    expect(result.items.map(item => item.externalId)).toEqual(["1-2", "1-3"]);
    expect(result.total).toBe(5);
    expect(result.hasMore).toBe(true);
  });

  it("propagates a follow-up page failure instead of returning an incomplete page", async () => {
    const { call } = mockTapd([260, 0, 0]);
    const original = call.getMockImplementation()!;
    call.mockImplementation(async (tool, args) => {
      if (tool === "stories_get" && args.page === 11) throw new Error("upstream unavailable");
      return original(tool, args);
    });
    await expect(tapdProvider.listCandidates(ctx, { scope: "test", page: 11, limit: 20 }))
      .rejects.toThrow("upstream unavailable");
  });

  it("clamps oversized UI limits before making upstream requests", async () => {
    const { call } = mockTapd([120, 10, 0]);
    const result = await tapdProvider.listCandidates(ctx, { scope: "test", page: 2, limit: 999 });
    expect(result.items).toHaveLength(30);
    expect(result.total).toBe(130);
    expect(result.hasMore).toBe(false);
    for (const [tool, args] of call.mock.calls) {
      if (tool !== "tapd_field_detail_get") expect(args.limit).toBe(100);
    }
  });
});
