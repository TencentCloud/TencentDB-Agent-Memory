/**
 * Regression: a committed turn must not be filtered out by its own capture.
 *
 * `TdaiCore.handleTurnCommitted` used to pass `turn.startedAt ?? Date.now()` as
 * the COLD-START FLOOR. That floor exists to skip pre-existing history on a
 * session that has no cursor yet, and l0-recorder keeps only messages with
 * `timestamp > floor`. But capture runs at the END of a turn, so `Date.now()`
 * sits at or after the moment the turn's own messages were stamped — the turn
 * being committed filtered itself out. Nothing recorded means no cursor is
 * persisted, so the next turn invented the same floor again: a session could
 * stay permanently empty while every request kept answering 200.
 *
 * Found by the tz-08 live run (`POST /memory/note` answering
 * `l0_recorded: 0`), reproduced deterministically here through `/capture`,
 * where a client can stamp its own messages.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freePort } from "../test-support/free-port.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TdaiGateway } from "./server.js";
import { parseConfig } from "../config.js";

let tmp: string;
let baseUrl: string;
let gateway: TdaiGateway;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "capture-floor-"));
  const base = path.join(tmp, "tdai");
  fs.mkdirSync(base, { recursive: true });
  const port = await freePort();
  gateway = new TdaiGateway({
    data: { baseDir: base },
    server: { port, host: "127.0.0.1", corsOrigins: [] },
    memory: parseConfig({}),
  });
  await gateway.start();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await gateway.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("POST /capture on a session with no cursor yet", () => {
  it("records messages stamped before the commit instead of dropping them", async () => {
    // The user wrote this 50ms before the turn was committed — the ordinary
    // case, since a turn takes time. With a `Date.now()` floor both messages
    // are silently dropped and the route still answers 200.
    const written = Date.now() - 50;
    const res = await fetch(`${baseUrl}/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_content: "вопрос",
        assistant_content: "ответ",
        session_key: `capture-floor-${Date.now()}`,
        messages: [
          { role: "user", content: "вопрос", timestamp: written },
          { role: "assistant", content: "ответ", timestamp: written + 1 },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { l0_recorded: number }).toMatchObject({
      l0_recorded: 2,
    });
  });
});
