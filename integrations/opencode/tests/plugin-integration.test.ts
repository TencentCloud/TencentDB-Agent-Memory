import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryTencentdbOpenCodePlugin } from "../src/index.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("MemoryTencentdbOpenCodePlugin", () => {
  it("connects recall, idle capture, deletion flush, and all tools", async () => {
    const stateDir = await mkdtemp(
      join(tmpdir(), "memory-tencentdb-opencode-"),
    );
    vi.stubEnv("MEMORY_TENCENTDB_OPENCODE_ENABLE_SUPERVISOR", "false");
    vi.stubEnv("MEMORY_TENCENTDB_OPENCODE_LOG_DIR", stateDir);
    const routes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input
              : input.url,
        );
        routes.push(url.pathname);
        const bodies: Record<string, unknown> = {
          "/health": {
            status: "ok",
            version: "test",
            uptime: 1,
            stores: { vectorStore: true, embeddingService: true },
          },
          "/recall": {
            context: "remembered",
            strategy: "hybrid",
            memory_count: 1,
          },
          "/capture": { l0_recorded: 2, scheduler_notified: true },
          "/session/end": { flushed: true },
        };
        return new Response(JSON.stringify(bodies[url.pathname]), {
          status: 200,
        });
      }),
    );

    const client = {
      app: { log: vi.fn(async () => undefined) },
      session: {
        messages: vi.fn(async () => ({
          data: [
            {
              info: { id: "u1", sessionID: "s1", role: "user" },
              parts: [{ type: "text", text: "request" }],
            },
            {
              info: {
                id: "a1",
                sessionID: "s1",
                role: "assistant",
                parentID: "u1",
                time: { completed: 2 },
              },
              parts: [{ type: "text", text: "answer" }],
            },
          ],
        })),
      },
    };
    try {
      const hooks = await MemoryTencentdbOpenCodePlugin({
        client,
        directory: process.cwd(),
        worktree: process.cwd(),
        project: {},
        serverUrl: new URL("http://127.0.0.1:4096"),
        experimental_workspace: { register: vi.fn() },
        $: vi.fn(),
      } as never);

      expect(Object.keys(hooks.tool ?? {})).toHaveLength(7);
      const output = {
        message: { id: "u1" },
        parts: [{ type: "text", text: "request" }],
      };
      await hooks["chat.message"]?.({ sessionID: "s1" }, output as never);
      expect(output.parts).toHaveLength(2);
      expect(output.parts[1]).toMatchObject({ synthetic: true });

      await hooks.event?.({
        event: { type: "session.idle", properties: { sessionID: "s1" } },
      } as never);
      await hooks.event?.({
        event: { type: "session.deleted", properties: { info: { id: "s1" } } },
      } as never);
      await hooks.dispose?.();

      expect(routes).toContain("/recall");
      expect(routes).toContain("/capture");
      expect(routes).toContain("/session/end");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
