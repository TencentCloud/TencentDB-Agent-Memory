/**
 * tz-06 Ф3 — the attempt row is where a session becomes findable.
 *
 * A sessionRef that only ever reaches a log line is not an audit trail: after
 * the run the operator has a run id and nothing else. So the launch writes it
 * onto the Attempt, and the terminal status lands on the SAME row.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultSpawnChild } from "./runner-helpers.js";
import { recordAttempt, listAttempts } from "../control-plane/attempt-repo.js";
import type { OrchestratorContext } from "./context.js";
import type { RoleLauncher } from "./launchers/types.js";

describe("tz-06 Ф3 — sessionRef on the attempt row", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tz06-f3-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function ctxWith(launcher: RoleLauncher): OrchestratorContext {
    return {
      dataDir: dir,
      now: () => Date.parse("2026-08-10T00:00:00.000Z"),
      childrenRef: { value: new Map() },
      launcherFor: () => launcher,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    } as unknown as OrchestratorContext;
  }

  const childCtx = (attemptId: string) =>
    ({
      runId: "r1",
      attemptId,
      cwd: dir,
      promptPath: path.join(dir, "p.md"),
      taskPrompt: "task",
      env: {},
      contract: { binding: { launcherId: "pi" } },
    }) as never;

  it("records sessionRef and the TERMINAL status on the launch attempt", async () => {
    const attemptId = recordAttempt(
      dir,
      "r1",
      "launch",
      "2026-08-10T00:00:00Z",
    );
    const launcher: RoleLauncher = {
      id: "pi",
      launch: async () => ({
        ok: true,
        handle: {
          sessionRef: "/scratch/attempts/a1/session",
          completion: Promise.resolve({
            status: "failed" as const,
            exitCode: 7,
            signal: null,
            stdout: "",
            stderr: "",
          }),
          cancelAndWait: async () => {
            throw new Error("not used");
          },
        },
      }),
    };

    await defaultSpawnChild(ctxWith(launcher), childCtx(attemptId));

    const [row] = listAttempts(dir, "r1");
    expect(row?.outcome).toBe("failed");
    const detail = JSON.parse(row?.detail ?? "{}");
    expect(detail.sessionRef).toBe("/scratch/attempts/a1/session");
    expect(detail.launcherId).toBe("pi");
    expect(detail.exitCode).toBe(7);
  });

  it("a host that refuses records the typed kind on the attempt", async () => {
    const attemptId = recordAttempt(
      dir,
      "r1",
      "launch",
      "2026-08-10T00:00:00Z",
    );
    const launcher: RoleLauncher = {
      id: "pi",
      launch: async () => ({
        ok: false,
        error: { kind: "binary-not-found", message: "ENOENT" },
      }),
    };

    const res = await defaultSpawnChild(ctxWith(launcher), childCtx(attemptId));

    expect(res.error).toContain("binary-not-found");
    const [row] = listAttempts(dir, "r1");
    expect(row?.outcome).toBe("binary-not-found");
    expect(JSON.parse(row?.detail ?? "{}").message).toBe("ENOENT");
  });
});
