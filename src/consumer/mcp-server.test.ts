/**
 * tz-08 Ф3 — what a host actually receives from the two tools.
 *
 * Driven through a real MCP client over an in-memory transport pair, so the
 * schemas, the tool names and the result shapes are the ones a host sees — not
 * a hand-rolled imitation of them.
 *
 * The case that matters most is the failure one: a rebuilding memory must
 * reach the host as an error with its kind intact. If it arrived as an empty
 * result, the session would conclude memory holds nothing (ТЗ R2/S4).
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createMemoryMcpServer,
  renderRegistration,
  UnknownHostError,
} from "./mcp-server.js";
import {
  parseHostId,
  resolveGatewayUrl,
  sessionKeyFor,
} from "./server-config.js";
import type { MemoryConsumer, NoteInput } from "./types.js";

/** A consumer that answers whatever the case is about, and records its input. */
function fakeConsumer(over: Partial<MemoryConsumer> = {}): MemoryConsumer & {
  notes: NoteInput[];
} {
  const notes: NoteInput[] = [];
  return {
    notes,
    search: async () => ({
      ok: true,
      results: "one memory",
      total: 1,
      strategy: "hybrid",
    }),
    note: async (input) => {
      notes.push(input);
      return {
        ok: true,
        l0Recorded: 1,
        schedulerNotified: true,
        sessionKey: "s",
      };
    },
    ...over,
  };
}

async function connect(consumer: MemoryConsumer, hostId = "claude") {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([
    createMemoryMcpServer(consumer, hostId).connect(serverSide),
    client.connect(clientSide),
  ]);
  return client;
}

describe("the MCP surface every host gets", () => {
  it("offers exactly two tools, on every host", async () => {
    const client = await connect(fakeConsumer());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "memory_note",
      "memory_search",
    ]);
  });

  it("returns the server's own result text and structured fields", async () => {
    const client = await connect(fakeConsumer());
    const r = await client.callTool({
      name: "memory_search",
      arguments: { query: "релиз", limit: 3 },
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({
      results: "one memory",
      total: 1,
      strategy: "hybrid",
    });
  });

  it("hands a rebuilding memory to the host as an error carrying its kind", async () => {
    const client = await connect(
      fakeConsumer({
        search: async () => ({
          ok: false,
          kind: "gated",
          message: "memory is rebuilding its index",
        }),
      }),
    );
    const r = await client.callTool({
      name: "memory_search",
      arguments: { query: "x" },
    });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0]?.text).toContain("[gated]");
  });

  it("stamps the note with the host's session, and the caller cannot forge it", async () => {
    const consumer = fakeConsumer();
    const client = await connect(consumer, "codex");
    await client.callTool({
      name: "memory_note",
      // sessionKey is deliberately not part of the tool's schema.
      arguments: { content: "заметка", session_key: "somebody-else" },
    });
    expect(consumer.notes[0]?.sessionKey).toBe("tdai-mcp-codex");
  });

  it("refuses an empty note argument before it reaches the gateway", async () => {
    const consumer = fakeConsumer();
    const client = await connect(consumer);
    const r = await client.callTool({
      name: "memory_note",
      arguments: { content: "" },
    });
    expect(r.isError).toBe(true);
    expect(consumer.notes).toEqual([]);
  });
});

describe("what the host tells the server", () => {
  it("prefers the registered flag, then the exported URL, then the port", () => {
    expect([
      // The flag wins: it is what a registration writes down, and whatever
      // environment a host happens to pass on must not override it.
      resolveGatewayUrl({ TDAI_GATEWAY_URL: "http://env:9000" }, [
        "--gateway",
        "http://flag:9500/",
      ]),
      resolveGatewayUrl({ TDAI_GATEWAY_URL: "http://gw:9000/" }),
      resolveGatewayUrl({ TDAI_GATEWAY_PORT: "9200" }),
      resolveGatewayUrl({}, ["--gateway"]),
      resolveGatewayUrl({}),
    ]).toEqual([
      "http://flag:9500",
      "http://gw:9000",
      "http://127.0.0.1:9200",
      "http://127.0.0.1:8420",
      "http://127.0.0.1:8420",
    ]);
  });

  // A gateway that took its port from its own yaml used to be invisible to the
  // consumer: the fallback knew only the env variable and 8420. On a machine
  // that also runs a default gateway, that is not "unavailable" — it is the
  // WRONG memory answering, and a note landing in it.
  it("finds the gateway named by the config file when no env names one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tz08-port-"));
    try {
      const configured = path.join(dir, "tdai-gateway.yaml");
      const portless = path.join(dir, "portless.yaml");
      fs.writeFileSync(
        configured,
        "server:\n  port: 9137\n  host: 127.0.0.1\n",
      );
      fs.writeFileSync(portless, "server:\n  host: 127.0.0.1\n");

      vi.stubEnv("TDAI_GATEWAY_CONFIG", configured);
      const fromConfig = resolveGatewayUrl({});
      vi.stubEnv("TDAI_GATEWAY_CONFIG", portless);
      const noPort = resolveGatewayUrl({});
      // The env still outranks the config: it is the more specific answer.
      const fromEnv = resolveGatewayUrl({ TDAI_GATEWAY_PORT: "9200" });

      expect([fromConfig, noPort, fromEnv]).toEqual([
        "http://127.0.0.1:9137",
        "http://127.0.0.1:8420",
        "http://127.0.0.1:9200",
      ]);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the host id from argv and falls back to the host that passes none", () => {
    expect([
      parseHostId(["--host", "codex"]),
      parseHostId(["--host"]),
      parseHostId(["--host", "--other"]),
      parseHostId([]),
    ]).toEqual(["codex", "pi", "pi", "pi"]);
  });

  it("keeps each host's notes in its own session", () => {
    expect([sessionKeyFor("pi"), sessionKeyFor("claude")]).toEqual([
      "tdai-mcp-pi",
      "tdai-mcp-claude",
    ]);
  });
});

describe("the registration a user pastes", () => {
  it("names the host's own file and points at the real launcher", () => {
    const claude = renderRegistration("claude", {});
    expect(claude).toContain("~/.claude.json");
    expect(claude).toContain("bin/tdai-memory-mcp.mjs");
    expect(renderRegistration("codex", {})).toContain(
      "[mcp_servers.tdai-memory]",
    );
    expect(renderRegistration("pi", {})).toContain("~/.pi/agent/mcp.json");
  });

  it("bakes in a gateway URL only when this environment names one", () => {
    // A default install gets no URL, so it keeps resolving the gateway at run
    // time instead of freezing today's loopback address into a config file.
    expect(renderRegistration("claude", {})).not.toContain("TDAI_GATEWAY_URL");
    expect(
      renderRegistration("claude", { TDAI_GATEWAY_URL: "http://gw:9000" }),
    ).toContain("http://gw:9000");
    // A port names the gateway just as much as a URL does, and the host starts
    // the server from its config file, never from the shell that printed this.
    // …on every host, including the one that passes no --host flag: whether a
    // host forwards environment to the servers it starts is its own business.
    for (const host of ["claude", "codex", "pi"]) {
      expect(renderRegistration(host, { TDAI_GATEWAY_PORT: "9999" })).toContain(
        "http://127.0.0.1:9999",
      );
    }
  });

  it("bakes in an address the host could not have found for itself", () => {
    // A config named by TDAI_GATEWAY_CONFIG resolves a port that NOTHING in the
    // pasted snippet carries: the host starts the launcher with its own
    // environment and would land on 8420 — another gateway's memory, on a
    // machine that runs a default one too.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tz08-origin-"));
    const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "tz08-cwd-"));
    try {
      const named = path.join(dir, "tdai-gateway.yaml");
      fs.writeFileSync(named, "server:\n  port: 9137\n");
      fs.writeFileSync(
        path.join(cwdDir, "tdai-gateway.yaml"),
        "server:\n  port: 9138\n",
      );
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(cwdDir);

      vi.stubEnv("TDAI_GATEWAY_CONFIG", named);
      expect(renderRegistration("claude", {})).toContain(
        "http://127.0.0.1:9137",
      );

      // A config in the CURRENT DIRECTORY cuts both ways. The GATEWAY honours
      // one (a user starting a server in a directory means that directory), so
      // a shell standing there is talking to that gateway and the snippet must
      // freeze its address. The RUNNING server must not: a host starts the
      // launcher wherever it likes, and letting that directory decide would
      // point the session at another memory.
      vi.stubEnv("TDAI_GATEWAY_CONFIG", "");
      expect(renderRegistration("claude", {})).toContain(
        "http://127.0.0.1:9138",
      );
      expect(resolveGatewayUrl({})).toBe("http://127.0.0.1:8420");

      cwd.mockReturnValue(dir); // no config in the current directory…
      fs.rmSync(named);
      const dataDir = path.join(dir, ".memory-tencentdb", "memory-tdai");
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(
        path.join(dataDir, "tdai-gateway.yaml"),
        "server:\n  port: 9139\n",
      );

      // A data dir a VARIABLE moved is this shell's answer: the host starts
      // the launcher without that variable and lands somewhere else, so the
      // address has to travel.
      vi.stubEnv("MEMORY_TENCENTDB_ROOT", path.join(dir, ".memory-tencentdb"));
      expect(renderRegistration("claude", {})).toContain(
        "http://127.0.0.1:9139",
      );

      // The same config found where the machine itself looks — under HOME —
      // is the MACHINE's answer: the host resolves it too, so the snippet
      // stays free of an address that could go stale.
      vi.stubEnv("MEMORY_TENCENTDB_ROOT", "");
      vi.stubEnv("HOME", dir);
      expect(renderRegistration("claude", {})).not.toContain("--gateway");
      expect(resolveGatewayUrl({})).toBe("http://127.0.0.1:9139");
      cwd.mockRestore();
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  it("prints the gateway this very command line would serve", () => {
    // The flag the user just typed must reach the snippet: printing a
    // different address than the same argv would serve sends them off to a
    // gateway they never named.
    const printed = renderRegistration(
      "claude",
      { TDAI_GATEWAY_PORT: "9999" },
      ["--gateway", "http://gw.example:9500"],
    );
    expect(printed).toContain("http://gw.example:9500");
    expect(printed).not.toContain("9999");
  });

  it("refuses a host it has no registration for, naming the ones it has", () => {
    expect(() => renderRegistration("emacs", {})).toThrow(UnknownHostError);
    expect(() => renderRegistration("emacs", {})).toThrow(
      /known hosts: pi, claude, codex/,
    );
  });
});
