/**
 * Real MiMo Code host A/B test with local mock Gateway and model provider.
 * Requires `mimo` 0.1.8+ on PATH, one completed MiMo startup/migration, and a
 * built `dist/adapters/mimo-code.mjs`.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function listen(server) {
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  return server.address().port;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function runMimo(args, options) {
  return new Promise((resolvePromise, reject) => {
    const windowsCli = process.env.MIMO_CLI_JS
      ?? join(process.env.APPDATA ?? "", "npm", "node_modules", "@mimo-ai", "cli", "bin", "mimo");
    const executable = process.platform === "win32" ? process.execPath : "mimo";
    const executableArgs = process.platform === "win32" ? [windowsCli, ...args] : args;
    const child = spawn(executable, executableArgs, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      if (process.platform === "win32") {
        try {
          execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        } catch {
          child.kill();
        }
      } else {
        child.kill("SIGKILL");
      }
      reject(new Error(`MiMo host test timed out\n${stderr.slice(-2000)}`));
    }, 120_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`MiMo exited ${code}\n${stdout.slice(-2000)}\n${stderr.slice(-4000)}`));
    });
  });
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "memory-tencentdb-mimo-host-"));
const projectRoot = resolve(".");
const configRoot = join(temporaryRoot, "config");
const dataRoot = join(temporaryRoot, "data");
const stateRoot = join(temporaryRoot, "state");
const cacheRoot = join(temporaryRoot, "cache");
for (const path of [configRoot, dataRoot, stateRoot, cacheRoot]) {
  mkdirSync(path, { recursive: true });
}

const existingDatabase = join(homedir(), ".local", "share", "mimocode", "mimocode.db");
if (!existsSync(existingDatabase)) {
  throw new Error("Run MiMo Code once so its database migration completes before this host test");
} else {
  const isolatedDataDirectory = join(dataRoot, "mimocode");
  mkdirSync(isolatedDataDirectory, { recursive: true });
  const source = new DatabaseSync(existingDatabase, { readOnly: true });
  try {
    await backup(source, join(isolatedDataDirectory, "mimocode.db"));
  } finally {
    source.close();
  }
}

const recallMarker = `HOST_RECALL_${Date.now()}`;
const providerRequests = [];
const gatewayCalls = [];

const gatewayServer = createServer(async (request, response) => {
  const body = await readJson(request);
  gatewayCalls.push({ path: request.url, body });
  response.setHeader("Content-Type", "application/json");
  if (request.url === "/recall") {
    response.end(JSON.stringify({ context: recallMarker, strategy: "host-test", memory_count: 1 }));
  } else if (request.url === "/capture") {
    response.end(JSON.stringify({ l0_recorded: 2, scheduler_notified: true }));
  } else if (request.url === "/session/end") {
    response.end(JSON.stringify({ flushed: true }));
  } else if (request.url === "/health") {
    response.end(JSON.stringify({
      status: "ok",
      version: "host-test",
      uptime: 1,
      stores: { vectorStore: true, embeddingService: true },
    }));
  } else {
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  }
});

const providerServer = createServer(async (request, response) => {
  const body = await readJson(request);
  providerRequests.push({ path: request.url, body });
  if (request.url?.endsWith("/models")) {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ object: "list", data: [{ id: "host-model", object: "model" }] }));
    return;
  }
  if (!request.url?.endsWith("/chat/completions")) {
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { message: `unexpected path ${request.url}` } }));
    return;
  }
  if (body.stream) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-host",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "host-model",
      choices: [{ index: 0, delta: { role: "assistant", content: "HOST_PROVIDER_OK" }, finish_reason: null }],
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-host",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "host-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    })}\n\n`);
    response.end("data: [DONE]\n\n");
    return;
  }
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({
    id: "chatcmpl-host",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "host-model",
    choices: [{ index: 0, message: { role: "assistant", content: "HOST_PROVIDER_OK" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
  }));
});

try {
  const gatewayPort = await listen(gatewayServer);
  const providerPort = await listen(providerServer);
  const adapterUrl = pathToFileURL(resolve("dist/adapters/mimo-code.mjs")).href;
  const pluginPath = join(temporaryRoot, "memory-tencentdb.mjs");
  writeFileSync(pluginPath, `
import { createMimoCodeMemoryPlugin } from ${JSON.stringify(adapterUrl)};
export const MemoryTencentDB = createMimoCodeMemoryPlugin({
  gatewayUrl: "http://127.0.0.1:${gatewayPort}",
  timeoutMs: 5000,
});
`);
  const configDirectory = join(configRoot, "mimocode");
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(join(configDirectory, "mimocode.jsonc"), JSON.stringify({
    $schema: "https://mimo.xiaomi.com/mimocode/config.json",
    plugin: [pathToFileURL(pluginPath).href],
    model: "host-test/host-model",
    small_model: "host-test/host-model",
    enabled_providers: ["host-test"],
    provider: {
      "host-test": {
        npm: "@ai-sdk/openai-compatible",
        name: "Host Test",
        options: {
          baseURL: `http://127.0.0.1:${providerPort}/v1`,
          apiKey: "host-test-key",
        },
        models: {
          "host-model": {
            name: "Host Model",
            limit: { context: 16_384, output: 1024 },
          },
        },
      },
    },
  }, null, 2));

  const environment = {
    ...process.env,
    XDG_CONFIG_HOME: configRoot,
    XDG_DATA_HOME: dataRoot,
    XDG_STATE_HOME: stateRoot,
    XDG_CACHE_HOME: cacheRoot,
    MEMORY_TENCENTDB_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
  };
  const commonArgs = [
    "run",
    "Reply exactly HOST_PROVIDER_OK",
    "--model", "host-test/host-model",
    "--format", "json",
    "--dir", projectRoot,
    "--dangerously-skip-permissions",
  ];

  await runMimo([...commonArgs, "--pure"], { cwd: projectRoot, env: environment });
  const controlRequest = providerRequests.find((entry) => entry.path?.endsWith("/chat/completions"));
  assert(controlRequest, "Control run never reached the model provider");
  assert(!JSON.stringify(controlRequest.body).includes(recallMarker), "Control request unexpectedly contained recalled memory");

  const providerCountBeforePlugin = providerRequests.length;
  await runMimo(commonArgs, { cwd: projectRoot, env: environment });
  const pluginRequests = providerRequests.slice(providerCountBeforePlugin);
  const pluginRequest = pluginRequests.find((entry) => entry.path?.endsWith("/chat/completions"));
  assert(pluginRequest, "Plugin run never reached the model provider");
  assert(JSON.stringify(pluginRequest.body).includes(recallMarker), "Recalled memory did not reach the model provider request");
  assert(gatewayCalls.some((entry) => entry.path === "/recall"), "MiMo host never called Gateway recall");
  assert(gatewayCalls.some((entry) => entry.path === "/capture"), "MiMo host never called Gateway capture");
  console.log("MIMO_HOST_AB_OK");
} catch (error) {
  console.error("host diagnostics", JSON.stringify({
    providerPaths: providerRequests.map((entry) => entry.path),
    gatewayPaths: gatewayCalls.map((entry) => entry.path),
  }));
  throw error;
} finally {
  await Promise.all([
    new Promise((resolvePromise) => gatewayServer.close(resolvePromise)),
    new Promise((resolvePromise) => providerServer.close(resolvePromise)),
  ]);
  try {
    rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    console.warn(`Unable to remove MiMo host test directory ${temporaryRoot}: ${error.message}`);
  }
}
