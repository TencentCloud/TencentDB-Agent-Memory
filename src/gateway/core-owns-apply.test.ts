/**
 * tz-09 Ф8 — `core-owns-apply`: a child never writes memory itself.
 *
 * Two doors are checked against a REAL gateway: the credential door (a child
 * has no token, so /memory/apply is 401) and the file door (a child that
 * edits a scene block behind the gateway's back is caught by the manifest
 * recheck when the apply arrives).
 *
 * The third case is deliberately a characterization, not a wish: a direct
 * write into vectors.db is caught by NOTHING here (plan §3 п.1). Pretending
 * otherwise would be worse than recording it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { TdaiGateway } from "./server.js";
import { parseConfig } from "../config.js";
import { createRun } from "./control-plane/run-repo.js";

vi.mock("./consolidation/child-spawn.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./consolidation/child-spawn.js")>();
  return { ...actual, sweepKeeperOrphans: vi.fn(() => 0) };
});

const META = [
  "-----META-START-----",
  "created: 2026-08-02T00:00:00Z",
  "updated: 2026-08-02T00:00:00Z",
  "summary: child-owned block",
  "heat: 1",
  "-----META-END-----",
].join("\n");

describe("tz-09 Ф8 — core owns apply", () => {
  let tmp: string;
  let base: string;
  let baseUrl: string;
  let gateway: TdaiGateway;
  let token: string;
  const rel = "scene_blocks/_global/owned.md";

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-owns-"));
    base = path.join(tmp, "tdai");
    fs.mkdirSync(path.join(base, "scene_blocks", "_global"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(base, "records"), { recursive: true });
    fs.writeFileSync(path.join(base, rel), `${META}\n\noriginal`, "utf-8");

    const port = 29_050 + Math.floor(Math.random() * 300);
    baseUrl = `http://127.0.0.1:${port}`;
    gateway = new TdaiGateway({
      data: { baseDir: base },
      server: { port, host: "127.0.0.1", corsOrigins: [] },
      memory: parseConfig({}),
    });
    await gateway.start();
    const info = (await (await fetch(`${baseUrl}/memory/info`)).json()) as {
      tokenPath: string;
    };
    token = fs.readFileSync(info.tokenPath, "utf-8").trim();
  });

  afterAll(async () => {
    await gateway.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function post(body: unknown, headers: Record<string, string> = {}) {
    return fetch(`${baseUrl}/memory/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  const emptyBody = (runId: string) => ({
    runId,
    diff: {},
    manifest: { baseline: {} },
    context: { presentedRecordIds: [] },
  });

  it("a child has no credential: /memory/apply is 401, not a validation error", async () => {
    expect((await post(emptyBody("nope"))).status).toBe(401);
    expect(
      (await post(emptyBody("nope"), { "x-memory-token": "guessed" })).status,
    ).toBe(401);
  });

  it("a child that edits a scene block directly is caught by the manifest", async () => {
    const abs = path.join(base, rel);
    const baselineSha = createHash("sha256")
      .update(fs.readFileSync(abs, "utf-8"))
      .digest("hex");

    // The child goes around the gateway and rewrites the file itself.
    fs.writeFileSync(abs, `${META}\n\nwritten by the child`, "utf-8");

    createRun(
      base,
      {
        runId: "run-drift",
        roleId: "memory-keeper",
        contractHash: "h",
        contractJson: "{}",
        binding: "{}",
      },
      new Date().toISOString(),
    );
    const res = await post(
      {
        runId: "run-drift",
        diff: {
          rewriteBlock: [{ path: rel, content: `${META}\n\nfrom apply` }],
        },
        manifest: { baseline: { [rel]: baselineSha } },
        context: { presentedRecordIds: [] },
      },
      { "x-memory-token": token },
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/drift|changed/i);
    // The apply did not overwrite the child's text — it refused.
    expect(fs.readFileSync(abs, "utf-8")).toContain("written by the child");
  });

  it("characterization: a direct vectors.db write is caught by nothing", () => {
    // No gate reads the store's own history, so this stays a known hole and
    // the reason `core-owns-apply` is a process rule, not only a code one.
    const guarded = fs
      .readFileSync(
        path.join(
          path.dirname(new URL(import.meta.url).pathname),
          "apply-executor/manifest.ts",
        ),
        "utf-8",
      )
      .includes("vectors.db");
    expect(guarded).toBe(false);
  });
});
