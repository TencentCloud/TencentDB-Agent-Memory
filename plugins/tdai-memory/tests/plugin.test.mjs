import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { executablePath, probe } from "../scripts/lib/health.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(script, args = [], env = {}) {
  return spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      TDAI_OPENAI_PLUGIN_CONFIG: path.join(os.tmpdir(), `tdai-plugin-missing-${process.pid}.json`),
      ...env,
    },
  });
}

function runAsync(script, args = [], env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "scripts", script), ...args], {
      cwd: root,
      env: {
        ...process.env,
        TDAI_OPENAI_PLUGIN_CONFIG: path.join(os.tmpdir(), `tdai-plugin-missing-${process.pid}.json`),
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end();
  });
}

test("manifest exposes Skill, MCP, and the Codex lifecycle hook contract", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, ".codex-plugin/plugin.json")));
  assert.equal(manifest.name, "tdai-memory");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(manifest.hooks, undefined);
  assert.equal(manifest.apps, undefined);
  const hooks = JSON.parse(await readFile(path.join(root, "hooks/hooks.json")));
  assert.deepEqual(Object.keys(hooks.hooks).sort(), [
    "SessionEnd",
    "SessionStart",
    "Stop",
    "UserPromptSubmit",
  ]);
  for (const entries of Object.values(hooks.hooks)) {
    const command = entries[0].hooks[0];
    assert.equal(command.commandWindows, command.command);
  }
});

test("repo marketplace exposes the same plugin identity", async () => {
  const marketplace = JSON.parse(await readFile(path.resolve(
    root,
    "../../.agents/plugins/marketplace.json",
  )));
  assert.equal(marketplace.name, "tencentdb-agent-memory");
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, "tdai-memory");
  assert.equal(marketplace.plugins[0].source.path, "./plugins/tdai-memory");
});

test("MCP config launches the delegating wrapper, not a bundled server", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, ".mcp.json")));
  assert.deepEqual(manifest.mcpServers["tdai-memory"], {
    cwd: ".",
    command: "node",
    args: ["./scripts/run-official-mcp.mjs"],
  });
  await assert.rejects(readFile(path.join(root, "mcp/server.mjs")));
});

test("setup is dry-run by default and never serializes an API key", () => {
  const result = run("setup.mjs", [], { TDAI_GATEWAY_API_KEY: "must-not-leak" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Dry run only/);
  assert.doesNotMatch(result.stdout, /must-not-leak/);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.gatewayUrl, "http://127.0.0.1:8420");
  assert.equal(parsed.mcpBinary, "memory-tencentdb-mcp");
  assert.deepEqual(parsed.mcpArgs, []);
});

test("setup rejects remote endpoints unless explicitly allowed", () => {
  const blocked = run("setup.mjs", ["--gateway-url", "https://memory.example.com"]);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /remote/);
  const allowed = run("setup.mjs", [
    "--gateway-url",
    "https://memory.example.com",
    "--allow-remote",
  ]);
  assert.equal(allowed.status, 0, allowed.stderr);
});

test("launcher delegates stdio to an external executable", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "tdai-plugin-test-"));
  const fake = path.join(temporary, "memory-tencentdb-mcp");
  await writeFile(fake, "#!/bin/sh\nprintf 'official-mcp-ok\\n'\n", "utf8");
  await chmod(fake, 0o755);
  const result = run("run-official-mcp.mjs", [], { TDAI_MEMORY_MCP_BIN: fake });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "official-mcp-ok\n");
});

const repositoryBuildAvailable = await access(path.resolve(root, "../../MemoryCore/dist/memory-tencentdb-mcp.mjs"))
  .then(() => true)
  .catch(() => false);

test("launcher discovers the v2 repository build without an override", {
  skip: !repositoryBuildAvailable,
}, async () => {
  const result = await runAsync("run-official-mcp.mjs", [], {
    TDAI_SERVICE_ID: "service-test",
    TDAI_INSTANCE_ID: "instance-test",
    TDAI_TEAM_ID: "team-test",
    TDAI_USER_ID: "user-test",
    TDAI_AGENT_ID: "agent-test",
    TDAI_SESSION_ID: "session-test",
  });
  // Closing stdin lets a correctly discovered stdio MCP process exit cleanly.
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /not found/i);
});

test("health probe accepts the official Gateway health contract", async () => {
  const result = await probe("gateway", "http://127.0.0.1:8420", async (url) => {
    assert.equal(url, "http://127.0.0.1:8420/health");
    return new Response(JSON.stringify({
      status: "ok",
      version: "test",
      uptime: 1,
      stores: { vectorStore: true, embeddingService: true },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  assert.equal(result.ok, true);
  assert.equal(result.body.version, "test");
});

test("health check resolves Windows commands through PATHEXT", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "tdai-plugin-test-"));
  const fake = path.join(temporary, "node.cmd");
  await writeFile(fake, "@echo off\r\n", "utf8");
  assert.equal(await executablePath("node", temporary, {
    platform: "win32",
    pathExt: ".EXE;.CMD",
  }), fake);
});

test("offline health check verifies the external executable without network", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "tdai-plugin-test-"));
  const fake = path.join(temporary, "memory-tencentdb-mcp");
  await writeFile(fake, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(fake, 0o755);
  const result = await runAsync("health-check.mjs", ["--json", "--offline"], {
    TDAI_MEMORY_MCP_BIN: fake,
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.gateway.skipped, true);
  assert.equal(report.memoryProxy.skipped, true);
});
