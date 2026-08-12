/**
 * tz-08 g4 (S4) — unavailability is not emptiness (ТЗ D1e, acceptance 5).
 *
 * "Nothing found" tells a session its memory holds nothing, so it writes down
 * what it already knows. A gateway that is down, and a memory that is
 * rebuilding, must therefore arrive as their own distinguishable answers —
 * never as an empty list.
 *
 * The `gated` shape is produced by a REAL gateway whose database is locked by
 * another process — the exact scenario a backup tool or a sibling gateway
 * creates. The store enters degraded mode for real (initRetryPending=true),
 * and the consumer keeps the answer distinguishable from an empty memory.
 * No HTTP stubs: the lock is a real `BEGIN EXCLUSIVE` held via node:sqlite.
 *
 * FALSIFY=empty-on-error — failures are collapsed into an empty result, the
 * way a wrapper that "just returns []" would. The legs must go false.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { must, finish } from "../tz07-probe/assert.mts";
import {
  freePort,
  startFakeLlm,
  startGateway,
  startHost,
  waitFor,
  writeSandboxConfig,
} from "./harness.mts";
import type { McpHost } from "./harness.mts";
import {
  describeAllHosts,
  resolveLauncherPath,
} from "../../src/consumer/hosts/registry.js";

const FALSIFY = process.env.FALSIFY ?? "";

function collapse(
  answer: string,
  isFailure = answer.includes("isError"),
): string {
  return FALSIFY === "empty-on-error" && isFailure
    ? JSON.stringify({ results: "", total: 0 })
    : answer;
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tz08-g4-"));
const dataDir = path.join(home, "memory", "tdai");
fs.mkdirSync(dataDir, { recursive: true });

const llm = await startFakeLlm();

async function runHosts(gwUrl: string): Promise<McpHost[]> {
  const ctx = { launcherPath: resolveLauncherPath(), gatewayUrl: gwUrl };
  const result: McpHost[] = [];
  for (const d of describeAllHosts(ctx)) result.push(await startHost(d));
  return result;
}

async function hostSearch(
  hosts: McpHost[],
  idx: number,
  query: string,
): Promise<string> {
  const reply = await hosts[idx]!.call("tools/call", {
    name: "memory_search",
    arguments: { query, limit: 3 },
  });
  return collapse(JSON.stringify(reply.result));
}

try {
  // ═══ Phase 1: baseline — alive gateway, real search ═══
  const p1 = await freePort();
  const gw1 = await startGateway({
    home,
    dataDir,
    port: p1,
    configPath: writeSandboxConfig(path.join(home, "gw1.yaml"), {
      dataDir,
      port: p1,
      llmUrl: llm.url,
    }),
  });
  const h1 = await runHosts(gw1.url);

  await h1[0]!.call("tools/call", {
    name: "memory_note",
    arguments: { content: "Заметка для базовой линии g4" },
  });
  await waitFor("corpus searchable", async () =>
    (await hostSearch(h1, 0, "потребител")).includes("Found"),
  );
  const alive = await hostSearch(h1, 0, "потребител");
  console.log("живой ответ:", alive);
  must("при живом gateway выдача непустая", alive.includes("Found"));

  const nothing = await hostSearch(h1, 0, "zzz-absent-query-xyzzy");
  console.log("пустой ответ:", nothing);
  must(
    "пустая выдача — не ошибка",
    nothing.includes("No matching memories") && !nothing.includes("isError"),
  );

  // ═══ Phase 2: locked fresh DB → degraded store → gated response ═══
  //
  // The probe stops the gateway, wipes the database, then creates a fresh
  // empty one and holds BEGIN EXCLUSIVE on it. A new gateway started against
  // the same dataDir hits the lock during initSchema() (CREATE TABLE needs
  // a write lock on a fresh DB), enters degraded mode, and answers "gated".
  for (const h of h1) h.stop();
  await gw1.stop();

  // Wipe the DB so CREATE TABLE is not a no-op.
  const dbPath = path.join(dataDir, "vectors.db");
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(dbPath + ext);
    } catch {
      /* ok */
    }
  }

  // Hold an exclusive lock on the fresh empty database.
  const { DatabaseSync } = await import("node:sqlite");
  const lockDb = new DatabaseSync(dbPath, { allowExtension: false });
  lockDb.exec("PRAGMA busy_timeout = 0");
  lockDb.exec("PRAGMA journal_mode = WAL");
  lockDb.exec("BEGIN EXCLUSIVE");

  const p2 = await freePort();
  const gw2 = await startGateway({
    home,
    dataDir,
    port: p2,
    configPath: writeSandboxConfig(path.join(home, "gw2.yaml"), {
      dataDir,
      port: p2,
      llmUrl: llm.url,
    }),
  });
  const h2 = await runHosts(gw2.url);

  for (const [i, host] of h2.entries()) {
    const reply = await host.call("tools/call", {
      name: "memory_search",
      arguments: { query: "заметка", limit: 3 },
    });
    const text = JSON.stringify(reply.result);
    console.log(`${host.id} с залоченной БД: ${text}`);
    must(
      `${host.id}: gated — отдельный вид, а не пустая выдача`,
      text.includes("[gated]"),
    );
    must(
      `${host.id}: gated не выглядит как пустая выдача`,
      !text.includes('"total":0') || text.includes("gated"),
    );
  }

  // ═══ Phase 3: lock released → store recovers ═══
  for (const h of h2) h.stop();
  await gw2.stop();
  lockDb.exec("ROLLBACK");
  lockDb.close();

  const p3 = await freePort();
  const gw3 = await startGateway({
    home,
    dataDir,
    port: p3,
    configPath: writeSandboxConfig(path.join(home, "gw3.yaml"), {
      dataDir,
      port: p3,
      llmUrl: llm.url,
    }),
  });
  const h3 = await runHosts(gw3.url);

  await h3[0]!.call("tools/call", {
    name: "memory_note",
    arguments: { content: "Заметка после восстановления" },
  });
  // The fake LLM returns DEFAULT_EXTRACTION with "Проверка потребителя памяти";
  // searching for "потребител" matches that extraction via FTS.
  await waitFor("recovered store searchable", async () =>
    (await hostSearch(h3, 0, "потребител")).includes("Found"),
  );
  const recovered = await hostSearch(h3, 0, "потребител");
  console.log("после восстановления:", recovered);
  must("после снятия блокировки данные доступны", recovered.includes("Found"));

  // ═══ Phase 4: gateway down → distinguishable failure ═══
  for (const h of h3) h.stop();
  await gw3.stop();

  const p4 = await freePort();
  const gw4 = await startGateway({
    home,
    dataDir,
    port: p4,
    configPath: writeSandboxConfig(path.join(home, "gw4.yaml"), {
      dataDir,
      port: p4,
      llmUrl: llm.url,
    }),
  });
  const h4 = await runHosts(gw4.url);
  await gw4.stop();

  const dead = [
    collapse(JSON.stringify((await h4[0]!.call("tools/call", { name: "memory_search", arguments: { query: "x", limit: 3 } })).result)),
    collapse(JSON.stringify((await h4[1]!.call("tools/call", { name: "memory_search", arguments: { query: "x", limit: 3 } })).result)),
    collapse(JSON.stringify((await h4[2]!.call("tools/call", { name: "memory_search", arguments: { query: "x", limit: 3 } })).result)),
  ];
  for (const [i, body] of dead.entries())
    console.log(`${h4[i]!.id} без gateway: ${body}`);
  must(
    "недоступность различима у всех трёх хостов",
    dead.every((body) => body.includes("unavailable")),
  );
  must(
    "недоступность не выглядит как пустая выдача",
    dead.every(
      (body) => !body.includes('"total":0') || body.includes("unavailable"),
    ),
  );

  for (const h of h4) h.stop();
} finally {
  await llm.close();
  fs.rmSync(home, { recursive: true, force: true });
}

finish();
