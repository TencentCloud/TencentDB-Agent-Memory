import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const PACKAGE_NAME = "@tencentdb-agent-memory/memory-tencentdb";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const packageManagerEntry = process.env.npm_execpath;
const root = process.cwd();
const temporary = await mkdtemp(path.join(tmpdir(), "memory-tencentdb-pack-smoke-"));
const packDirectory = path.join(temporary, "pack");
const installDirectory = path.join(temporary, "consumer");

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  });
}

function runPackageManager(args, options = {}) {
  if (packageManagerEntry) {
    return run(process.execPath, [packageManagerEntry, ...args], options);
  }
  return run(npmCommand, args, {
    shell: process.platform === "win32",
    ...options,
  });
}

function safeChildEnvironment() {
  const safe = {};
  for (const key of [
    "APPDATA",
    "ComSpec",
    "HOME",
    "LOCALAPPDATA",
    "PATH",
    "Path",
    "PATHEXT",
    "SYSTEMROOT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
  ]) {
    if (process.env[key] !== undefined) safe[key] = process.env[key];
  }
  return safe;
}

async function assertGatewayExport() {
  const probe = path.join(installDirectory, "gateway-probe.mjs");
  await writeFile(probe, `
import { GatewayMemoryClient } from ${JSON.stringify(`${PACKAGE_NAME}/gateway-client`)};
const client = new GatewayMemoryClient({
  fetch: async (_url, init) => {
    if (init.redirect !== "manual") throw new Error("redirect policy missing");
    return new Response(JSON.stringify({
      status: "ok",
      version: "pack-smoke",
      uptime: 1,
      stores: { vectorStore: true, embeddingService: false }
    }), { headers: { "content-type": "application/json" } });
  }
});
const result = await client.health();
if (result.version !== "pack-smoke") throw new Error("gateway export failed");
`, "utf8");
  run(process.execPath, [probe], { cwd: installDirectory });
}

async function assertMcpExecutable(packageRoot) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const {
    getDefaultEnvironment,
    StdioClientTransport,
  } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const entry = path.join(packageRoot, "dist", "memory-tencentdb-mcp.mjs");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: installDirectory,
    env: {
      ...getDefaultEnvironment(),
      TDAI_CODEX_SESSION_KEY: "codex:pack-smoke",
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const client = new Client({ name: "pack-smoke", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    if (tools.tools.length !== 5) {
      throw new Error(`expected 5 MCP tools, received ${tools.tools.length}`);
    }
  } catch (error) {
    throw new Error(
      `installed MCP executable failed: ${
        error instanceof Error ? error.message : String(error)
      }${stderr ? `\nstderr:\n${stderr}` : ""}`,
      { cause: error },
    );
  } finally {
    await client.close().catch(() => {});
  }
  if (stderr) throw new Error(`MCP wrote to stderr during startup: ${stderr}`);
}

function assertClaudeExecutable(packageRoot) {
  const entry = path.join(packageRoot, "dist", "memory-tencentdb-claude-hook.mjs");
  const stdout = run(process.execPath, [entry], {
    cwd: installDirectory,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "pack-smoke",
      reason: "other",
    }),
    env: {
      ...safeChildEnvironment(),
      CLAUDE_PLUGIN_DATA: path.join(temporary, "claude data"),
      TDAI_GATEWAY_URL: "http://127.0.0.1:1",
      TDAI_GATEWAY_TIMEOUT_MS: "100",
    },
  });
  const parsed = JSON.parse(stdout);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Claude Hook did not emit a JSON object");
  }
}

try {
  await mkdir(packDirectory, { recursive: true });
  await mkdir(installDirectory, { recursive: true });

  runPackageManager([
    "pack",
    "--pack-destination",
    packDirectory,
  ], {
    env: {
      ...process.env,
      npm_config_ignore_scripts: "true",
    },
  });
  const tarballs = (await readdir(packDirectory)).filter(
    (entry) => entry.endsWith(".tgz"),
  );
  if (tarballs.length !== 1) {
    throw new Error(`npm pack produced ${tarballs.length} tarballs`);
  }
  const tarball = path.join(packDirectory, tarballs[0]);

  runPackageManager(["init", "-y"], { cwd: installDirectory });
  runPackageManager([
    "install",
    "--ignore-scripts",
    tarball,
  ], {
    cwd: installDirectory,
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_legacy_peer_deps: "true",
      npm_config_optional: "false",
    },
  });

  const packageRoot = path.join(
    installDirectory,
    "node_modules",
    "@tencentdb-agent-memory",
    "memory-tencentdb",
  );
  const manifest = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  );

  await assertGatewayExport();
  if (manifest.bin?.["memory-tencentdb-mcp"]) {
    await assertMcpExecutable(packageRoot);
  }
  if (manifest.bin?.["memory-tencentdb-claude-hook"]) {
    assertClaudeExecutable(packageRoot);
  }

  process.stdout.write(
    `Packed install smoke passed (${Object.keys(manifest.bin ?? {}).join(", ")})\n`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
