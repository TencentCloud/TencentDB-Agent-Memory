import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.mjs";

const completeConfig = {
  endpoint: "http://127.0.0.1:8420/",
  hubEndpoint: "http://127.0.0.1:8125/",
  apiKey: "local-test-key",
  serviceId: "default",
  identity: {
    teamId: "team-personal",
    agentId: "agent-personal",
    userId: "user-jin",
    taskId: "task-test"
  }
};

async function withConfig(config, run) {
  const dir = await mkdtemp(join(tmpdir(), "tdam-config-"));
  try {
    if (config !== undefined) {
      await writeFile(join(dir, "config.local.json"), JSON.stringify(config), "utf8");
    }
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("loadConfig rejects a missing local configuration file", async () => {
  await withConfig(undefined, async (dir) => {
    await assert.rejects(() => loadConfig(dir), /config\.local\.json/);
  });
});

test("loadConfig requires the complete shared identity", async () => {
  const config = structuredClone(completeConfig);
  delete config.identity.taskId;

  await withConfig(config, async (dir) => {
    await assert.rejects(() => loadConfig(dir), /identity\.taskId/);
  });
});

test("loadConfig requires every fixed identity and connection field", async () => {
  const missingFields = [
    ["endpoint", (config) => delete config.endpoint],
    ["apiKey", (config) => delete config.apiKey],
    ["serviceId", (config) => delete config.serviceId],
    ["identity.teamId", (config) => delete config.identity.teamId],
    ["identity.agentId", (config) => delete config.identity.agentId],
    ["identity.userId", (config) => delete config.identity.userId],
    ["identity.taskId", (config) => delete config.identity.taskId]
  ];

  for (const [field, remove] of missingFields) {
    const config = structuredClone(completeConfig);
    remove(config);
    await withConfig(config, async (dir) => {
      await assert.rejects(() => loadConfig(dir), new RegExp(field.replace(".", "\\.")));
    });
  }
});

test("loadConfig rejects blank required fields without exposing their values", async () => {
  const config = structuredClone(completeConfig);
  config.serviceId = "   ";

  await withConfig(config, async (dir) => {
    await assert.rejects(
      () => loadConfig(dir),
      (error) => /serviceId/.test(error.message) && !error.message.includes("local-test-key")
    );
  });
});

test("loadConfig normalizes the endpoint and supplies adapter defaults", async () => {
  await withConfig(completeConfig, async (dir) => {
    const config = await loadConfig(dir);

    assert.equal(config.endpoint, "http://127.0.0.1:8420");
    assert.equal(config.hubEndpoint, "http://127.0.0.1:8125");
    assert.equal(config.timeouts.recallMs, 1200);
    assert.equal(config.timeouts.captureMs, 3000);
    assert.equal(config.queue.retryBatchSize, 3);
    assert.equal(Object.isFrozen(config), true);
    assert.equal(Object.isFrozen(config.identity), true);
  });
});

test("loadConfig keeps existing Hook configs compatible by defaulting a missing Hub endpoint", async () => {
  const legacy = structuredClone(completeConfig);
  delete legacy.hubEndpoint;
  await withConfig(legacy, async (dir) => {
    const config = await loadConfig(dir);
    assert.equal(config.hubEndpoint, "http://127.0.0.1:8125");
  });
});

test("loadConfig rejects an unsafe Hub endpoint", async () => {
  const config = structuredClone(completeConfig);
  config.hubEndpoint = "file:///tmp/panel";
  await withConfig(config, async (dir) => {
    await assert.rejects(loadConfig(dir), /hubEndpoint|HTTP\(S\)/i);
  });
});

test("config example remains valid as a user-copyable starting point", async () => {
  const examplePath = new URL("../config.example.json", import.meta.url);
  const example = JSON.parse(await readFile(examplePath, "utf8"));

  await withConfig(example, async (dir) => {
    const config = await loadConfig(dir);
    assert.equal(config.endpoint, "http://127.0.0.1:8420");
    assert.equal(config.hubEndpoint, "http://127.0.0.1:8125");
    assert.equal(config.identity.taskId, "task-generated-example");
  });
});
