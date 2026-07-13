/**
 * Install the tencentdb-memory plugin into Codex's local marketplace.
 *
 * This development install links the repository plugin directory into
 * ~/.agents/plugins/tencentdb-memory instead of copying it. The marketplace
 * entry is still written normally, so Codex can discover and install the
 * plugin while local edits remain visible after Codex refreshes/restarts.
 *
 * Usage: node scripts/install-codex-plugin.js
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

// ============================
// Configuration
// ============================

const PLUGIN_NAME = "tencentdb-memory";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PLUGIN_SRC_DIR = path.join(
  PROJECT_ROOT,
  "codex-plugin",
  "memory",
  "memory_tencentdb",
);
const MARKETPLACE_DIR = path.join(os.homedir(), ".agents", "plugins");
const MARKETPLACE_FILE = path.join(MARKETPLACE_DIR, "marketplace.json");
const PLUGIN_INSTALL_DIR = path.join(MARKETPLACE_DIR, PLUGIN_NAME);
const CODEX_CONFIG_FILE = path.join(os.homedir(), ".codex", "config.toml");
const PLUGIN_CONFIG_ID = `${PLUGIN_NAME}@local-codex-plugins`;
const MCP_SERVER_NAME = "tdai-memory";

// ============================
// Helpers
// ============================

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function loadMarketplace() {
  if (!fs.existsSync(MARKETPLACE_FILE)) {
    return { name: "local-codex-plugins", plugins: [] };
  }
  try {
    const raw = fs.readFileSync(MARKETPLACE_FILE, "utf-8");
    const marketplace = JSON.parse(raw);
    if (!marketplace.plugins) marketplace.plugins = [];
    if (!marketplace.name) marketplace.name = "local-codex-plugins";
    return marketplace;
  } catch (err) {
    fail(`Failed to parse existing marketplace.json: ${err}`);
  }
}

function saveMarketplace(marketplace) {
  ensureDir(MARKETPLACE_DIR);
  fs.writeFileSync(
    MARKETPLACE_FILE,
    JSON.stringify(marketplace, null, 2) + "\n",
    "utf-8",
  );
}

function removeExistingLink(target) {
  if (!fs.existsSync(target)) return;

  const stat = fs.lstatSync(target);
  if (!stat.isSymbolicLink()) {
    fail(
      `Refusing to remove non-symlink install directory: ${target}\n` +
        "Delete it manually if you want to replace the copied install with a link.",
    );
  }

  fs.rmSync(target, { recursive: true, force: true });
}

function linkDir(src, dest) {
  removeExistingLink(dest);
  fs.symlinkSync(src, dest, process.platform === "win32" ? "junction" : "dir");
}

function createPluginEntry() {
  // Codex local marketplace paths must be ./-prefixed and relative to the
  // marketplace root. On Windows, the personal marketplace is resolved from
  // the home directory in current Codex builds, so keep the .agents/plugins
  // prefix used by the previous installer.
  const relPath = path.relative(os.homedir(), PLUGIN_INSTALL_DIR).split(path.sep).join("/");
  return {
    name: PLUGIN_NAME,
    source: {
      source: "local",
      path: `./${relPath}`,
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category: "Productivity",
  };
}

function upsertTomlKey(lines, start, end, key, value) {
  const keyPattern = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = start; i < end; i++) {
    if (keyPattern.test(lines[i])) {
      lines[i] = `${key} = ${value}`;
      return;
    }
  }
  lines.splice(end, 0, `${key} = ${value}`);
}

function enablePluginMcpServer() {
  const section = `[plugins."${PLUGIN_CONFIG_ID}".mcp_servers."${MCP_SERVER_NAME}"]`;
  ensureDir(path.dirname(CODEX_CONFIG_FILE));

  const raw = fs.existsSync(CODEX_CONFIG_FILE)
    ? fs.readFileSync(CODEX_CONFIG_FILE, "utf-8")
    : "";
  const lines = raw ? raw.replace(/\r\n/g, "\n").split("\n") : [];
  let start = lines.findIndex((line) => line.trim() === section);

  if (start < 0) {
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
    lines.push(section);
    lines.push("enabled = true");
    lines.push('default_tools_approval_mode = "prompt"');
  } else {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\s*\[.*\]\s*$/.test(lines[i])) {
        end = i;
        break;
      }
    }
    upsertTomlKey(lines, start + 1, end, "enabled", "true");
    end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\s*\[.*\]\s*$/.test(lines[i])) {
        end = i;
        break;
      }
    }
    upsertTomlKey(lines, start + 1, end, "default_tools_approval_mode", '"prompt"');
  }

  fs.writeFileSync(CODEX_CONFIG_FILE, lines.join("\n").replace(/\n*$/, "\n"), "utf-8");
}

function quotedToml(value) {
  return JSON.stringify(value);
}

function tomlArray(values) {
  return `[${values.map((value) => quotedToml(value)).join(", ")}]`;
}

function upsertTomlSection(section, entries) {
  ensureDir(path.dirname(CODEX_CONFIG_FILE));

  const raw = fs.existsSync(CODEX_CONFIG_FILE)
    ? fs.readFileSync(CODEX_CONFIG_FILE, "utf-8")
    : "";
  const lines = raw ? raw.replace(/\r\n/g, "\n").split("\n") : [];
  let start = lines.findIndex((line) => line.trim() === section);

  if (start < 0) {
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
    lines.push(section);
    for (const [key, value] of Object.entries(entries)) {
      lines.push(`${key} = ${value}`);
    }
  } else {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\s*\[.*\]\s*$/.test(lines[i])) {
        end = i;
        break;
      }
    }
    for (const [key, value] of Object.entries(entries)) {
      upsertTomlKey(lines, start + 1, end, key, value);
      end = lines.length;
      for (let i = start + 1; i < lines.length; i++) {
        if (/^\s*\[.*\]\s*$/.test(lines[i])) {
          end = i;
          break;
        }
      }
    }
  }

  fs.writeFileSync(CODEX_CONFIG_FILE, lines.join("\n").replace(/\n*$/, "\n"), "utf-8");
}

function enableGlobalMcpServer() {
  const mcpServerPath = path
    .join(PLUGIN_SRC_DIR, "mcp-server.ts")
    .split(path.sep)
    .join("/");
  const projectRoot = PROJECT_ROOT.split(path.sep).join("/");
  upsertTomlSection(`[mcp_servers."${MCP_SERVER_NAME}"]`, {
    command: quotedToml("cmd.exe"),
    args: tomlArray(["/c", "npx", "tsx", mcpServerPath]),
    cwd: quotedToml(projectRoot),
    startup_timeout_sec: "30",
    env_vars: tomlArray([
      "TDAI_GATEWAY_URL",
      "TDAI_GATEWAY_API_KEY",
    ]),
  });
}

// ============================
// Run
// ============================

console.log(`Installing ${PLUGIN_NAME} plugin via directory link...`);
console.log(`  Plugin source:  ${PLUGIN_SRC_DIR}`);
console.log(`  Plugin link:    ${PLUGIN_INSTALL_DIR}`);
console.log(`  Marketplace:    ${MARKETPLACE_FILE}`);

const manifestPath = path.join(PLUGIN_SRC_DIR, ".codex-plugin", "plugin.json");
if (!fs.existsSync(manifestPath)) {
  fail(`Plugin manifest not found at ${manifestPath}`);
}

ensureDir(MARKETPLACE_DIR);
linkDir(PLUGIN_SRC_DIR, PLUGIN_INSTALL_DIR);
console.log("Plugin link created.");

const marketplace = loadMarketplace();

const legacyIdx = marketplace.plugins.findIndex((p) => p.name === "memory-tencentdb");
if (legacyIdx >= 0) {
  marketplace.plugins.splice(legacyIdx, 1);
  console.log("Removed legacy 'memory-tencentdb' entry.");
}

const entry = createPluginEntry();
const existingIdx = marketplace.plugins.findIndex((p) => p.name === PLUGIN_NAME);
if (existingIdx >= 0) {
  marketplace.plugins[existingIdx] = entry;
  console.log(`Updated existing ${PLUGIN_NAME} entry.`);
} else {
  marketplace.plugins.push(entry);
  console.log(`Added ${PLUGIN_NAME} entry.`);
}

saveMarketplace(marketplace);
console.log(`Marketplace saved to ${MARKETPLACE_FILE}`);
enablePluginMcpServer();
console.log(`Enabled plugin MCP server in ${CODEX_CONFIG_FILE}`);
enableGlobalMcpServer();
console.log(`Enabled global MCP server '${MCP_SERVER_NAME}' in ${CODEX_CONFIG_FILE}`);
console.log("");

let cliInstalled = false;
try {
  execSync(`codex plugin add ${PLUGIN_NAME}@${marketplace.name}`, {
    stdio: "pipe",
    timeout: 30_000,
  });
  console.log(`Installed ${PLUGIN_NAME} via Codex CLI.`);
  cliInstalled = true;
} catch {
  // Codex CLI may be unavailable or may not know the marketplace yet.
}

console.log("");
console.log("Next steps:");
console.log("  1. Restart Codex");
if (cliInstalled) {
  console.log("  2. Review and trust the plugin hooks with /hooks or Settings -> Hooks");
} else {
  console.log(`  2. Install or enable \"${PLUGIN_NAME}\" from the ${marketplace.name} marketplace`);
  console.log("  3. Review and trust the plugin hooks with /hooks or Settings -> Hooks");
}
console.log("");
console.log("Notes:");
console.log("  - This script does not bundle .ts files; it links to repository source.");
console.log("  - Plugin MCP, hooks, and skills are discovered from .codex-plugin/plugin.json.");
console.log("  - Installing/enabling a plugin does not automatically trust its hooks.");
