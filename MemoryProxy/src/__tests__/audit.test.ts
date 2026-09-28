import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAuditLine,
  buildAuditPayload,
  type AuditPayload,
  type MemoryAccessEvent,
} from "../audit.js";

const savedEnv = { file: process.env.AUDIT_LOG_FILE, max: process.env.AUDIT_LOG_MAX_BYTES };
const tmpDirs: string[] = [];

afterAll(async () => {
  process.env.AUDIT_LOG_FILE = savedEnv.file;
  if (savedEnv.max === undefined) delete process.env.AUDIT_LOG_MAX_BYTES;
  else process.env.AUDIT_LOG_MAX_BYTES = savedEnv.max;
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
});

describe("memory-access audit payload", () => {
  it("字段归一：默认值、完整 traceId、长度封顶", () => {
    const payload = buildAuditPayload(
      {
        actorUser: "u1",
        action: "recall",
        target: "team1:agent1".repeat(40),
        result: 3,
        sessionKey: "s-1",
        traceId: "9f2c5a61-2b8e-4f3d-9a10-abcdef123456",
      },
      new Date("2026-09-06T00:00:00.000Z"),
    );
    expect(payload.actor_user).toBe("u1");
    expect(payload.actor_agent).toBe("-");
    expect(payload.scope).toBe("normal");
    expect(payload.trace_id).toBe("9f2c5a61-2b8e-4f3d-9a10-abcdef123456");
    expect(payload.result).toBe(3);
    expect(payload.target.length).toBe(256);
    expect(payload.ts).toBe("2026-09-06T00:00:00.000Z");
  });

  it("无 traceId / 无 actor 时给空串与匿名，不抛错", () => {
    const payload = buildAuditPayload({
      action: "write",
      target: "t:a",
      result: "l0",
    } as MemoryAccessEvent);
    expect(payload.trace_id).toBe("");
    expect(payload.actor_user).toBe("anonymous");
  });
});

describe("audit JSONL 落盘与轮转", () => {
  it("超过大小上限后轮转到 <file>.1，业务侧不抛错", async () => {
    const dir = await mkdtemp(join(tmpdir(), "audit-test-"));
    tmpDirs.push(dir);
    const file = join(dir, "audit.jsonl");
    process.env.AUDIT_LOG_FILE = file;
    process.env.AUDIT_LOG_MAX_BYTES = "1024";

    // 单行约 700B：两行必然超过 1024 上限，单行不超过，轮转时机确定
    const makePayload = (i: number): AuditPayload =>
      buildAuditPayload({
        actorUser: `user-${i}`.padEnd(100, "u"),
        actorAgent: `agent-${i}`.padEnd(80, "a"),
        action: "write",
        target: `team-x:agent-y:task-${i}`.padEnd(200, "x"),
        result: `l0-${i}`.padEnd(100, "r"),
        sessionKey: `s-${i}`.padEnd(80, "s"),
        traceId: `trace-${i}`.padEnd(60, "t"),
      });
    const payloads = [makePayload(0), makePayload(1), makePayload(2)];
    // 前两条累计超过 1024 字节 → 第三条 append 前触发轮转
    for (const p of payloads) {
      await expect(appendAuditLine(p)).resolves.toBeUndefined();
    }
    const current = await readFile(file, "utf8");
    expect(current).toContain("user-2");
    const rotated = await readFile(`${file}.1`, "utf8");
    expect(rotated).toContain("user-0");
    expect(rotated).toContain("user-1");
    expect(rotated).not.toContain("user-2");

    delete process.env.AUDIT_LOG_FILE;
    delete process.env.AUDIT_LOG_MAX_BYTES;
  });
});
