import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VectorStore } from "../core/store/sqlite/memory-store.js";
import { CheckpointManager } from "../utils/checkpoint.js";

const run = promisify(execFile);
const scope = { teamId: "team-a", userId: "user-a", agentId: "agent-a",
  sessionKey: "session-key", sessionId: "session-a", taskId: "" };
const recordedAt = "2026-10-01T00:00:00.000Z";
const sourceLauncher = `import {main} from './src/cli/replay-l1.ts';
  main(process.argv.slice(1)).catch(e => { console.error(e.message); process.exitCode = 1; });`;

describe("replay-l1 command with real SQLite and local OpenAI-compatible HTTP", () => {
  let dir: string;
  let store: VectorStore;
  let server: Server;
  let requests: { messages: { content: string }[] }[];
  let reply: string;
  let status: number;
  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "replay-cli-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 0); store.init();
    requests = []; status = 200;
    reply = JSON.stringify([{ scene_name: "Atlas", message_ids: ["original-id"], memories: [{
      content: "Project Atlas freezes until Friday", type: "work_fact", priority: 80,
      source_message_ids: ["original-id"], metadata: {},
    }] }]);
    server = createServer(async (req, res) => {
      let body = ""; for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(status === 200 ? JSON.stringify({ id: "chatcmpl-test", object: "chat.completion",
        created: 1, model: "test", choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }) : JSON.stringify({ error: { message: "Synthetic provider failure", type: "test_error" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    writeFileSync(path.join(dir, "llm.json"), JSON.stringify({ baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "synthetic-test-key", model: "test", timeoutMs: 3000 }));
    add("original-id");
  });
  afterEach(async () => {
    store.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  function add(id: string, overrides: Partial<typeof scope> = {}) {
    expect(store.upsertL0({ id, ...scope, ...overrides, role: "user", messageText: `Atlas conversation ${id}`,
      recordedAt, timestamp: Date.parse(recordedAt) }, undefined)).toBe(true);
  }
  function cli(extra: string[], instance = "default") {
    return run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", sourceLauncher, "--",
      "--data-dir", dir, "--instance-id", instance, "--team-id", scope.teamId, "--user-id", scope.userId,
      "--agent-id", scope.agentId, "--session-key", scope.sessionKey, "--session-id", scope.sessionId,
      "--task-id", scope.taskId, ...extra,
    ], { cwd: process.cwd(), timeout: 15000, env: { ...process.env, REPLAY_LLM_API_KEY: "" } });
  }
  const apply = () => ["--apply", "--maintenance", "--fts-only", "--mode", "code", "--llm-config", path.join(dir, "llm.json")];

  it("dry-run is read-only, requires no model config, and lists the selected original IDs", async () => {
    add("foreign", { teamId: "team-b" });
    store.getRawDb().exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const bytes = readFileSync(path.join(dir, "vectors.db"));
    const result = JSON.parse((await cli(["--dry-run"])).stdout);
    expect(result).toMatchObject({ dryRun: true, selected: 1, batches: 1, sourceIds: ["original-id"] });
    expect(requests).toEqual([]);
    expect(readFileSync(path.join(dir, "vectors.db"))).toEqual(bytes);
    expect(store.getRawDb().prepare("SELECT name FROM sqlite_master WHERE name LIKE 'l1_replay_%'").all()).toEqual([]);
  });

  it("recovers historical L0 through HTTP and a second process makes no duplicate request or memory", async () => {
    add("foreign", { teamId: "team-b" });
    const cursor = Date.parse(recordedAt) + 1000;
    const checkpointManager = new CheckpointManager(dir);
    await checkpointManager.markL1ExtractionComplete(scope.sessionKey, 0, cursor, "previous scene");
    const checkpointPath = path.join(dir, ".metadata", "recall_checkpoint.json");
    const checkpoint = readFileSync(checkpointPath);
    expect(store.queryL0ForL1(scope.sessionKey, cursor)).toEqual([]);
    const l0 = store.getRawDb().prepare("SELECT * FROM l0_conversations ORDER BY record_id").all();
    const result = JSON.parse((await cli(apply())).stdout);
    expect(result).toMatchObject({ completed: 1, indexMode: "fts-only" });
    expect(requests).toHaveLength(1);
    const prompt = requests[0].messages.map((m) => m.content).join("\n");
    expect(prompt).toContain("[original-id]"); expect(prompt).not.toContain("Atlas conversation foreign");
    const records = store.getRawDb().prepare("SELECT * FROM l1_records").all();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ team_id: "team-a", user_id: "user-a", agent_id: "agent-a", task_id: "" });
    expect(store.getRawDb().prepare("SELECT record_id FROM l1_fts WHERE l1_fts MATCH 'Atlas'").all()).toHaveLength(1);
    const second = JSON.parse((await cli(apply())).stdout);
    expect(second.alreadyComplete).toBe(1); expect(second.receipts).toEqual(result.receipts);
    expect(requests).toHaveLength(1);
    expect(store.getRawDb().prepare("SELECT * FROM l1_records").all()).toEqual(records);
    expect(store.getRawDb().prepare("SELECT * FROM l0_conversations ORDER BY record_id").all()).toEqual(l0);
    expect(readFileSync(checkpointPath)).toEqual(checkpoint);
    expect((await checkpointManager.read()).runner_states[scope.sessionKey].last_l1_cursor).toBe(cursor);
  });

  it("preserves existing vector records and embedding metadata when adding FTS-only recovery", async () => {
    store.close(); store = new VectorStore(path.join(dir, "vectors.db"), 3);
    store.init({ provider: "openai", model: "test-embedding" });
    expect(store.isDegraded()).toBe(false);
    expect(store.upsertL1({ id: "existing-vector", ...scope, content: "Existing vector memory", type: "work_fact",
      priority: 70, scene_name: "Existing", source_message_ids: [], metadata: {}, timestamps: [recordedAt],
      createdAt: recordedAt, updatedAt: recordedAt,
    }, new Float32Array([1, 0, 0]))).toBe(true);
    const meta = store.getRawDb().prepare("SELECT * FROM embedding_meta ORDER BY key").all();
    const vectors = store.getRawDb().prepare("SELECT record_id, embedding FROM l1_vec ORDER BY record_id").all();
    expect(vectors).toHaveLength(1);
    await cli(apply());
    expect(store.getRawDb().prepare("SELECT * FROM embedding_meta ORDER BY key").all()).toEqual(meta);
    expect(store.getRawDb().prepare("SELECT record_id, embedding FROM l1_vec ORDER BY record_id").all()).toEqual(vectors);
    expect(store.getRawDb().prepare("SELECT count(*) AS n FROM l1_records").get()?.n).toBe(2);
  });

  it.each(["provider", "parse"])("a %s failure exits nonzero and remains recoverable on the next process", async (failure) => {
    const good = reply;
    if (failure === "provider") status = 401; else reply = "invalid JSON";
    await expect(cli(apply())).rejects.toMatchObject({ code: 1 });
    expect(store.getRawDb().prepare("SELECT * FROM l1_records").all()).toEqual([]);
    expect(JSON.parse((await cli(["--dry-run"])).stdout).alreadyComplete).toBe(0);
    status = 200; reply = good;
    expect(JSON.parse((await cli(apply())).stdout).completed).toBe(1);
    expect(requests).toHaveLength(2);
  });

  it("reuses a prepared extraction across process failure without another HTTP request", async () => {
    store.getRawDb().exec("CREATE TRIGGER disk_full BEFORE INSERT ON l1_records BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    await expect(cli(apply())).rejects.toMatchObject({ code: 1 });
    expect(requests).toHaveLength(1);
    expect(store.getRawDb().prepare("SELECT * FROM l1_records").all()).toEqual([]);
    store.getRawDb().exec("DROP TRIGGER disk_full");
    status = 401; // Retry must succeed even with the provider now unavailable.
    expect(JSON.parse((await cli(apply())).stdout).completed).toBe(1);
    expect(requests).toHaveLength(1);
  });

  it("separates instance databases even when all message IDs and tenant dimensions match", async () => {
    const instanceDir = path.join(dir, "instances", "another"); mkdirSync(instanceDir, { recursive: true });
    const other = new VectorStore(path.join(instanceDir, "vectors.db"), 0); other.init();
    try {
      other.upsertL0({ id: "original-id", ...scope, role: "user", messageText: "Other instance secret",
        recordedAt, timestamp: Date.parse(recordedAt) }, undefined);
      await cli(apply());
      expect(other.getRawDb().prepare("SELECT * FROM l1_records").all()).toEqual([]);
      expect(JSON.parse((await cli(["--dry-run"], "another")).stdout).alreadyComplete).toBe(0);
      expect(requests[0].messages.map((m) => m.content).join("\n")).not.toContain("Other instance secret");
    } finally { other.close(); }
  });

  it("rejects unsafe instance paths, missing stores, and symlinks without creating a database", async () => {
    await expect(cli(["--dry-run"], "../escape")).rejects.toMatchObject({ code: 1 });
    await expect(cli(["--dry-run"], "missing")).rejects.toMatchObject({ code: 1 });
    const target = path.join(dir, "instances", "linked"); mkdirSync(target, { recursive: true });
    symlinkSync(path.join(dir, "vectors.db"), path.join(target, "vectors.db"));
    await expect(cli(["--dry-run"], "linked")).rejects.toMatchObject({ code: 1 });
    expect(requests).toHaveLength(0);
  });

  it("requires explicit maintenance and index mode before calling the model or writing a journal", async () => {
    await expect(cli(["--apply", "--llm-config", path.join(dir, "llm.json")])).rejects.toMatchObject({ code: 1 });
    expect(requests).toHaveLength(0);
    expect(store.getRawDb().prepare("SELECT name FROM sqlite_master WHERE name LIKE 'l1_replay_%'").all()).toEqual([]);
  });
});
