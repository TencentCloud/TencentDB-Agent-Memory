import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";

import {
  classify,
  handleUsageRead,
  judgeOutcome,
  resolveUsageOptions,
  shanghaiDay,
  UsageStore,
} from "./usage-api.js";

test("six data-plane paths map to layer and action; health is ignored", () => {
  assert.deepEqual(classify("POST", "/v3/conversation/add"), { layer: "L0", action: "write", kind: "write" });
  assert.deepEqual(classify("POST", "/v3/conversation/search"), { layer: "L0", action: "search", kind: "search" });
  assert.deepEqual(classify("POST", "/v3/atomic/search"), { layer: "L1", action: "search", kind: "search" });
  assert.deepEqual(classify("POST", "/v3/scenario/ls"), { layer: "L2", action: "read", kind: "list" });
  assert.deepEqual(classify("POST", "/v3/scenario/read"), { layer: "L2", action: "read", kind: "file" });
  assert.deepEqual(classify("POST", "/v3/core/read"), { layer: "L3", action: "read", kind: "file" });
  assert.equal(classify("GET", "/health"), null);
  assert.equal(classify("GET", "/v3/usage/summary"), null);
  assert.equal(classify("POST", "/v3/conversation/delete"), null);
});

test("empty search is a miss, error envelopes are errors, and a successful write is accepted", () => {
  const search = classify("POST", "/v3/conversation/search");
  assert.equal(judgeOutcome(search, 200, { code: 0, data: { messages: [] } }).outcome, "miss");
  assert.equal(judgeOutcome(search, 200, { code: 400, message: "bad" }).outcome, "error");
  assert.equal(judgeOutcome(search, 503, { code: 0, data: { messages: [{ score: 1 }] } }).outcome, "error");

  const write = classify("POST", "/v3/conversation/add");
  const accepted = judgeOutcome(write, 200, { code: 0, data: { id: "m1" } });
  assert.equal(accepted.outcome, "accepted");
  assert.equal(accepted.hitCount, 0);

  const hit = judgeOutcome(search, 200, {
    code: 0,
    data: { messages: [{ score: 0.2, content: "secret-body" }, { score: 0.9, content: "other" }] },
  });
  assert.equal(hit.outcome, "hit");
  assert.equal(hit.hitCount, 2);
  assert.equal(hit.topScore, 0.9);
  assert.equal(JSON.stringify(hit).includes("secret-body"), false);

  const l1 = judgeOutcome(classify("POST", "/v3/atomic/search"), 200, {
    code: 0,
    data: {
      items: [
        { type: "fact", score: 0.4, content: "secret-body" },
        { type: "fact", score: 0.1, content: "secret-body" },
        { type: "preference", score: 0.2, content: "secret-body" },
      ],
    },
  });
  assert.equal(l1.outcome, "hit");
  assert.deepEqual(l1.typeCounts, { fact: 2, preference: 1 });
  assert.equal(l1.topScore, 0.4);

  const list = classify("POST", "/v3/scenario/ls");
  assert.equal(judgeOutcome(list, 200, { code: 0, data: { entries: [] } }).outcome, "miss");
  assert.equal(judgeOutcome(list, 200, { code: 0, data: { entries: [{ path: "a.md" }] } }).outcome, "hit");

  const file = classify("POST", "/v3/core/read");
  assert.equal(judgeOutcome(file, 200, { code: 0, data: { content: null } }).outcome, "miss");
  assert.equal(judgeOutcome(file, 200, { code: 0, data: { content: "persona" } }).outcome, "hit");
  assert.equal(judgeOutcome(classify("POST", "/v3/scenario/read"), 200, { code: 0, data: { content: "" } }).outcome, "miss");
});

test("usage rows go to their own sqlite file, old rows are deleted on open, and a write failure leaves the memory response unchanged", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-usage-"));
  const memoryPath = path.join(dir, "memory.sqlite");
  const usagePath = path.join(dir, "usage.sqlite");
  fs.writeFileSync(memoryPath, "");
  const current = Date.parse("2026-10-05T00:00:00+08:00");
  const options = {
    enabled: true,
    retentionDays: 30,
    dbPath: usagePath,
    now: () => current,
    disableTimer: true,
  };

  const store = new UsageStore(options);
  const response = {
    code: 0,
    data: { messages: [{ content: "secret-body", score: 0.4 }] },
  };
  const recorded = store.observe({
    method: "POST",
    pathname: "/v3/conversation/search",
    status: 200,
    requestBody: { query: "secret-query-text", user_id: "u-visible", messages: [{ content: "secret-body" }] },
    responseBody: response,
    startedAt: current - 12,
    now: current,
  });
  assert.equal(recorded.recorded, true);
  assert.equal(response.data.messages[0].content, "secret-body");
  assert.equal(fs.existsSync(usagePath), true);
  assert.notEqual(usagePath, memoryPath);

  store.insert = {
    run() {
      throw new Error("disk full");
    },
  };
  const again = store.observe({
    method: "POST",
    pathname: "/v3/conversation/add",
    status: 200,
    requestBody: { user_id: "u-visible" },
    responseBody: { code: 0, data: { id: "m1" } },
    startedAt: current - 3,
    now: current,
  });
  assert.equal(again.recorded, false);
  assert.equal(again.response.code, 0);
  store.close();

  const raw = fs.readFileSync(usagePath);
  assert.equal(raw.includes("secret-query-text"), true);
  assert.equal(raw.includes("secret-body"), false);
  assert.equal(fs.readFileSync(memoryPath).includes("memory_usage"), false);

  const oldNow = Date.parse("2026-08-01T00:00:00+08:00");
  const aging = new UsageStore({ ...options, now: () => oldNow });
  aging.observe({
    method: "POST",
    pathname: "/v3/conversation/add",
    status: 200,
    requestBody: { user_id: "old-user" },
    responseBody: { code: 0, data: {} },
    startedAt: oldNow,
    now: oldNow,
  });
  aging.close();

  const reopened = new UsageStore(options);
  const recent = reopened.recent({ limit: 50 });
  assert.equal(recent.items.some((row) => row.user_id === "old-user"), false);
  assert.equal(recent.items.some((row) => row.user_id === "u-visible"), true);
  reopened.close();
});

test("standalone usage is on by default and service mode stays off", () => {
  assert.equal(resolveUsageOptions({ deployMode: "standalone", dataDir: "/data/tdai-memory" }, {}).enabled, true);
  assert.equal(resolveUsageOptions({ deployMode: "service", dataDir: "/data/tdai-memory" }, {}).enabled, false);
  assert.equal(resolveUsageOptions({ deployMode: "service", usage: { enabled: true } }, {}).enabled, true);
  assert.equal(resolveUsageOptions({ deployMode: "standalone" }, {}).retentionDays, 30);
  assert.equal(
    resolveUsageOptions({ deployMode: "standalone", dataDir: "/data/tdai-memory" }, {}).dbPath,
    path.join("/data/tdai-memory", "usage.sqlite"),
  );
});

test("summary hit rate counts searches and reads only", () => {
  const now = Date.parse("2026-10-05T08:00:00+08:00");
  const { store, close } = openStore(now);
  record(store, "/v3/conversation/add", { code: 0, data: {} }, now - 2, { user_id: "u1" });
  record(store, "/v3/atomic/search", { code: 0, data: { items: [{ type: "fact", score: 0.5 }] } }, now - 1, { user_id: "u1" });
  record(store, "/v3/conversation/search", { code: 0, data: { messages: [] } }, now, { user_id: "u2" });

  const summary = store.summary({});
  assert.equal(summary.calls, 3);
  assert.equal(summary.hit_rate, 0.5);
  assert.equal(summary.hits, 1);
  assert.equal(summary.misses, 1);
  close();
});

test("timeseries buckets by Asia/Shanghai calendar day and defaults to the last 30 days", () => {
  assert.equal(shanghaiDay(Date.parse("2026-10-04T16:30:00Z")), "2026-10-05");
  assert.equal(shanghaiDay(Date.parse("2026-10-04T15:30:00Z")), "2026-10-04");

  const now = Date.parse("2026-10-05T23:59:59+08:00");
  const { store, close } = openStore(now);
  record(store, "/v3/conversation/add", { code: 0, data: {} }, Date.parse("2026-10-05T00:30:00+08:00"), { user_id: "u1" });
  record(store, "/v3/atomic/search", { code: 0, data: { items: [] } }, Date.parse("2026-10-05T23:30:00+08:00"), { user_id: "u1" });
  record(store, "/v3/core/read", { code: 0, data: { content: "x" } }, Date.parse("2026-08-01T00:00:00+08:00"), { user_id: "old" });

  const series = store.timeseries({ bucket: "day" });
  const oct5 = series.points.find((point) => point.bucket === "2026-10-05");
  assert.ok(oct5);
  assert.equal(oct5.calls, 2);
  assert.equal(oct5.writes, 1);
  assert.equal(oct5.searches, 1);
  assert.equal(series.points.some((point) => point.bucket === "2026-08-01"), false);
  assert.equal(series.points[0].bucket >= "2026-09-05", true);
  close();
});

test("recent is newest first, filters by user layer and outcome, and caps the page size", () => {
  const now = Date.parse("2026-10-05T12:00:00+08:00");
  const { store, close } = openStore(now);
  record(store, "/v3/conversation/add", { code: 0, data: {} }, now - 3000, { user_id: "ada" });
  record(store, "/v3/atomic/search", { code: 0, data: { items: [{ type: "fact", score: 0.2 }] } }, now - 2000, { user_id: "ada" });
  record(store, "/v3/conversation/search", { code: 0, data: { messages: [] } }, now - 1000, { user_id: "bea" });

  const filtered = store.recent({ userId: "ada", layer: "L1", outcome: "hit", limit: 50 });
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.items[0].user_id, "ada");
  assert.equal(filtered.items[0].layer, "L1");
  assert.equal(filtered.items[0].outcome, "hit");
  assert.equal(JSON.stringify(filtered).includes("secret"), false);

  const ordered = store.recent({ limit: 50 });
  assert.deepEqual(ordered.items.map((row) => row.user_id), ["bea", "ada", "ada"]);

  for (let i = 0; i < 210; i += 1) {
    record(store, "/v3/conversation/add", { code: 0, data: {} }, now - 300_000 + i, { user_id: "bulk" });
  }
  assert.equal(store.recent({}).items.length, 50);
  assert.equal(store.recent({ limit: 500 }).items.length, 200);
  close();
});

test("search rows keep a capped query and leave message bodies out", () => {
  const now = Date.parse("2026-10-05T12:00:00+08:00");
  const { store, close } = openStore(now);
  const longQuery = "q".repeat(512) + "tail";
  record(
    store,
    "/v3/atomic/search",
    { code: 0, data: { items: [{ type: "fact", score: 0.2, content: "secret-body" }] } },
    now,
    { query: longQuery, user_id: "ada" },
  );
  record(
    store,
    "/v3/conversation/add",
    { code: 0, data: {} },
    now - 1,
    { query: "should-not-keep-write", messages: [{ content: "secret-body" }] },
  );
  record(
    store,
    "/v3/core/read",
    { code: 0, data: { content: "secret-body" } },
    now - 2,
    { query: "should-not-keep-read", user_id: "ada" },
  );

  const recent = store.recent({ limit: 50 });
  assert.equal(recent.items[0].query, "q".repeat(512));
  assert.equal(recent.items[1].query, "");
  assert.equal(recent.items[2].query, "");
  close();

  const raw = fs.readFileSync(store.options.dbPath);
  assert.equal(raw.includes("secret-body"), false);
  assert.equal(raw.includes("should-not-keep-write"), false);
  assert.equal(raw.includes("should-not-keep-read"), false);
  assert.equal(raw.includes("tail"), false);
});

test("an existing usage database gains the query column without losing rows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-usage-"));
  const dbPath = path.join(dir, "usage.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE memory_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_ms INTEGER NOT NULL,
      layer TEXT NOT NULL,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      hit_count INTEGER NOT NULL,
      top_score REAL,
      team_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      path TEXT NOT NULL,
      type_counts TEXT NOT NULL
    )
  `);
  db.close();

  const now = Date.parse("2026-10-05T12:00:00+08:00");
  const store = new UsageStore({
    enabled: true,
    retentionDays: 30,
    dbPath,
    now: () => now,
    disableTimer: true,
  });
  record(
    store,
    "/v3/conversation/search",
    { code: 0, data: { messages: [] } },
    now,
    { query: "earlier session" },
  );
  assert.equal(store.recent({}).items[0].query, "earlier session");
  store.close();
});

test("missing bearer is rejected and does not write a usage row", () => {
  const now = Date.parse("2026-10-05T12:00:00+08:00");
  const { store, close } = openStore(now);
  store.observe = () => {
    throw new Error("read endpoints must not record");
  };
  const before = store.count();
  for (const pathname of ["/v3/usage/summary", "/v3/usage/timeseries", "/v3/usage/recent"]) {
    const denied = handleUsageRead({
      method: "GET",
      pathname,
      searchParams: new URLSearchParams(),
      store,
      authorized: false,
    });
    assert.equal(denied.status, 401);
    assert.equal(denied.body.code, 401);
  }
  assert.equal(store.count(), before);
  close();
});

function openStore(now = Date.parse("2026-10-05T12:00:00+08:00")) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-usage-"));
  const store = new UsageStore({
    enabled: true,
    retentionDays: 30,
    dbPath: path.join(dir, "usage.sqlite"),
    now: () => now,
    disableTimer: true,
  });
  return {
    store,
    close() {
      store.close();
    },
  };
}

function record(store, pathname, responseBody, now, requestBody) {
  const result = store.observe({
    method: "POST",
    pathname,
    status: 200,
    requestBody,
    responseBody,
    startedAt: now - 5,
    now,
  });
  assert.equal(result.recorded, true);
}
