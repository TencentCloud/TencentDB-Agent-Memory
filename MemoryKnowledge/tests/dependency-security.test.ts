import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { JaegerPropagator } from "@opentelemetry/propagator-jaeger";
import { ROOT_CONTEXT, defaultTextMapGetter, trace } from "@opentelemetry/api";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createDb } from "../src/db/client.js";
import { knowledgeWiki } from "../src/db/schema.js";

for (const key of ["uber-trace-id", "uberctx-synthetic"]) {
  it(`ignores malformed percent encoding in ${key}`, () => {
    const propagator = new JaegerPropagator();
    expect(() => propagator.extract(ROOT_CONTEXT, { [key]: "%" }, defaultTextMapGetter)).not.toThrow();
  });
}

it("still extracts ordinary Jaeger trace context", () => {
  const carrier = { "uber-trace-id": "463ac35c9f6413ad48485a3953bb6124:a2fb4a1d1a96d312:0:1" };
  const context = new JaegerPropagator().extract(ROOT_CONTEXT, carrier, defaultTextMapGetter);
  expect(trace.getSpanContext(context)?.traceId).toBe("463ac35c9f6413ad48485a3953bb6124");
});

it("quotes SQL identifiers containing a double quote", () => {
  const { db, raw } = createDb({ path: ":memory:" });
  try {
    raw.exec(`CREATE TABLE "quote""name" ("v" TEXT); INSERT INTO "quote""name" VALUES ('synthetic');`);
    const table = sqliteTable('quote"name', { value: text("v") });
    expect(db.select().from(table).all()).toEqual([{ value: "synthetic" }]);
  } finally {
    raw.close();
  }
});

it("retains Knowledge schema migration and ordinary metadata writes", () => {
  const { db, raw } = createDb({ path: ":memory:" });
  try {
    const at = "2026-10-14T00:00:00Z";
    db.insert(knowledgeWiki).values({
      wikiId: "synthetic-wiki", serviceId: "synthetic-service", teamId: "synthetic-team",
      name: "Synthetic", createdAt: at, updatedAt: at,
    }).run();
    expect(db.select().from(knowledgeWiki).all()).toMatchObject([{ wikiId: "synthetic-wiki", name: "Synthetic" }]);
    expect(raw.pragma("integrity_check", { simple: true })).toBe("ok");
  } finally {
    raw.close();
  }
});

it("retains ordinary Git init, commit, clone and status operations", async () => {
  const root = mkdtempSync(join(tmpdir(), "dependency-git-"));
  try {
    const repository = join(root, "source");
    const git = simpleGit();
    mkdirSync(repository);
    await simpleGit(repository).init();
    const source = simpleGit(repository);
    await source.addConfig("user.name", "Synthetic");
    await source.addConfig("user.email", "synthetic@example.test");
    writeFileSync(join(repository, "data.txt"), "synthetic\n");
    await source.add("data.txt");
    await source.commit("Synthetic fixture");
    const clone = join(root, "clone");
    await git.clone(repository, clone);
    expect((await simpleGit(clone).status()).isClean()).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("rejects Git configuration includes before attempting a Git operation", async () => {
  const root = mkdtempSync(join(tmpdir(), "dependency-git-guard-"));
  try {
    const git = simpleGit(root);
    await git.init();
    await expect(git.raw(["-c", `include.path=${join(root, "missing.config")}`, "status"]))
      .rejects.toThrow(/include|unsafe|allowUnsafe/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
