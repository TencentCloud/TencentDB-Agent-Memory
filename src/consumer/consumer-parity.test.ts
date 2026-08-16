/**
 * tz-08 — INVARIANT `consumer-parity`, proven the only way that counts.
 *
 * Three real child processes, started with exactly the command line, argv and
 * env their descriptor declares, talking MCP over stdio to ONE real gateway
 * process. Not three calls to one in-process object — that would prove the
 * object is deterministic, which nobody doubted.
 *
 * What must hold (ТЗ acceptance 1-5):
 *   1. the three offer the same operations, with the same argument schemas;
 *   2. the same query gives byte-identical answers on all three;
 *   3. a note written through the wrapper lands in L0 once and comes back
 *      through search — the ordinary path, no second write route (D1d);
 *   4. reading needs no credential, writing without one is refused (D1c);
 *   5. a dead gateway is a distinguishable failure on all three, never an
 *      empty result (D1e).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  REPO_ROOT,
  freePort,
  startFakeLlm,
  startGateway,
  startHost,
  waitFor,
  writeSandboxConfig,
  type FakeLlm,
  type Gateway,
  type McpHost,
} from "../../scripts/tz08-probe/harness.mts";
import { installFakeL1RoleHost } from "../../scripts/tz08-probe/fake-l1-role-host.mts";
import { listRecentRuns } from "../gateway/control-plane/run-repo.js";
import { listAttempts } from "../gateway/control-plane/attempt-repo.js";
import { describeAllHosts, resolveLauncherPath } from "./hosts/registry.js";

/**
 * The suite builds what it needs. `npx vitest run` on a freshly cloned tree
 * has no dist/, and a test that silently skips there proves nothing.
 */
function ensureBuild(): void {
  const built = path.join(REPO_ROOT, "dist", "mcp-server.mjs");
  const newestSource = ["src/consumer", "src/gateway", "src/utils", "index.ts"]
    .flatMap((rel) => walk(path.join(REPO_ROOT, rel)))
    .reduce((max, file) => Math.max(max, fs.statSync(file).mtimeMs), 0);
  if (fs.existsSync(built) && fs.statSync(built).mtimeMs >= newestSource)
    return;
  execFileSync("npm", ["run", "build:plugin"], {
    cwd: REPO_ROOT,
    stdio: "pipe",
  });
}

function walk(target: string): string[] {
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return [target];
  return fs
    .readdirSync(target)
    .flatMap((entry) => walk(path.join(target, entry)));
}

let home: string;
let dataDir: string;
let gateway: Gateway;
let llm: FakeLlm;
let hosts: McpHost[];
let token: string;

const QUERY = "потребитель памяти";
const NOTE_MARKER = `парити-${Date.now()}`;

beforeAll(async () => {
  ensureBuild();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "tz08-parity-"));
  dataDir = path.join(home, "memory", "tdai");
  fs.mkdirSync(dataDir, { recursive: true });

  // The extraction echoes the marker of whatever note it is given, so "the
  // note came back" is about THAT note: with a fixed extraction the seeded
  // memory answers the query and the leg passes without the note existing.
  llm = await startFakeLlm();
  const piBinary = installFakeL1RoleHost(dataDir, home);
  const port = await freePort();
  const configPath = writeSandboxConfig(path.join(home, "gateway.yaml"), {
    dataDir,
    port,
    llmUrl: llm.url,
    piBinary,
  });
  gateway = await startGateway({ home, dataDir, port, configPath });
  token = fs
    .readFileSync(
      path.join(path.dirname(dataDir), "tdai-gateway.token"),
      "utf-8",
    )
    .trim();

  // Started by the registry's own output — not by a command line this test
  // invented, or the three "hosts" would be one host under three names.
  const ctx = { launcherPath: resolveLauncherPath(), gatewayUrl: gateway.url };
  hosts = [];
  for (const descriptor of describeAllHosts(ctx)) {
    // Started with no environment of our own: the registration carries the
    // gateway, and a host that lost it must fail here rather than be rescued.
    hosts.push(await startHost(descriptor));
  }

  // Seed the corpus BEFORE comparing answers. Three hosts agreeing on
  // "No matching memories found." is not parity — it is three identical
  // nothings, and it would stay green even if the wrapper mangled real
  // results. The comparison below therefore runs against a non-empty answer.
  await hosts[0]!.call("tools/call", {
    name: "memory_note",
    arguments: { content: `Затравка корпуса: ${QUERY} под тремя хостами` },
  });
  await waitFor("the seeded note to become searchable", async () => {
    const answer = await searchThrough(hosts[0]!);
    return (answer.structuredContent as { total?: number } | undefined)?.total
      ? true
      : false;
  });
}, 300_000);

afterAll(async () => {
  for (const host of hosts ?? []) host.stop();
  await gateway?.stop();
  await llm?.close();
  fs.rmSync(home, { recursive: true, force: true });
});

/** The tool result body, with the volatile parts left alone. */
async function searchThrough(host: McpHost, query = QUERY) {
  const reply = await host.call("tools/call", {
    name: "memory_search",
    arguments: { query, limit: 5 },
  });
  return (reply.result ?? reply.error) as Record<string, unknown>;
}

describe("consumer-parity", () => {
  it("starts the three hosts with three genuinely different command lines", () => {
    const lines = hosts.map((h) => h.commandLine);
    expect(new Set(lines).size).toBe(3);
    // Printed so a reader can see the three real forms in the run output.
    console.log(lines.join("\n"));
  });

  it("offers the same operations and the same argument schemas everywhere", async () => {
    const surfaces = await Promise.all(
      hosts.map(async (host) => {
        const reply = await host.call("tools/list", {});
        const tools = (
          reply.result as { tools: { name: string; inputSchema: unknown }[] }
        ).tools;
        // Names and schemas — descriptions are prose and may differ freely.
        return JSON.stringify(
          tools
            .map((t) => [t.name, t.inputSchema])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        );
      }),
    );
    expect(new Set(surfaces).size).toBe(1);
    expect(surfaces[0]).toContain("memory_search");
    expect(surfaces[0]).toContain("memory_note");
  });

  it("answers one query identically on all three", async () => {
    const answers = await Promise.all(hosts.map((h) => searchThrough(h)));
    console.log("answer:", JSON.stringify(answers[0]));
    // Non-empty first: parity over an empty result proves nothing.
    const structured = answers[0]!.structuredContent as {
      total: number;
      results: string;
    };
    expect(structured.total).toBeGreaterThan(0);
    expect(structured.results).not.toContain("No matching memories");
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
  });

  it("writes a note through the wrapper once, and finds it again", async () => {
    const marker = NOTE_MARKER;
    const reply = await hosts[0]!.call("tools/call", {
      name: "memory_note",
      arguments: { content: `Заметка потребителя: ${marker}` },
    });
    const written = (
      reply.result as { structuredContent: { l0_recorded: number } }
    ).structuredContent;
    expect(written.l0_recorded).toBe(1);

    // Exactly one L0 record for that text — the note joins the existing
    // capture path and does not open a second one (INVARIANT nogo-l0-path).
    const conversations = path.join(home, "memory", "tdai", "conversations");
    const occurrences =
      walk(conversations)
        .map((file) => fs.readFileSync(file, "utf-8"))
        .join("")
        .split(marker).length - 1;
    expect(occurrences).toBe(1);

    // …and THIS note becomes findable through the ordinary extraction path,
    // on a host other than the one that wrote it.
    await waitFor("the note to reach L1 and become searchable", async () => {
      const answer = await searchThrough(hosts[1]!, marker);
      return JSON.stringify(answer).includes(marker);
    });
    const run = listRecentRuns(dataDir).find(
      ({ roleId, state }) => roleId === "l1-extractor" && state === "applied",
    );
    expect(run).toBeDefined();
    expect(
      listAttempts(dataDir, run!.runId).map(({ outcome }) => outcome),
    ).toEqual(["succeeded"]);
  });

  it("reads without a credential and refuses a write without one", async () => {
    // The gate is the server's, and the wrapper must neither weaken it nor
    // carry a token where none is needed (D1c). Checked at the HTTP boundary
    // because an MCP client cannot ask the wrapper to drop its credential.
    const read = await fetch(`${gateway.url}/memory/search?query=x`);
    const blindWrite = await fetch(`${gateway.url}/memory/note`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "без токена" }),
    });
    const withToken = await fetch(`${gateway.url}/memory/note`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-memory-token": token },
      body: JSON.stringify({ content: "с токеном" }),
    });
    expect([read.status, blindWrite.status, withToken.status]).toEqual([
      200, 401, 200,
    ]);
  });

  it("reports a dead gateway as a failure on all three, not as an empty answer", async () => {
    await gateway.stop();
    const answers = await Promise.all(
      hosts.map((h) => searchThrough(h, "что угодно")),
    );
    for (const [i, answer] of answers.entries()) {
      const text = JSON.stringify(answer);
      expect([hosts[i]!.id, (answer as { isError?: boolean }).isError]).toEqual(
        [hosts[i]!.id, true],
      );
      expect(text).toContain("unavailable");
    }
    console.log("gateway down:", JSON.stringify(answers[0]));
  });
});
