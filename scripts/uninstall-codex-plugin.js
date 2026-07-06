/**
 * Uninstall the tencentdb-memory plugin from Codex's local marketplace.
 *
 * Removes the plugin entry from ~/.agents/plugins/marketplace.json,
 * deletes the copied plugin directory, and prints guidance for remaining
 * manual cleanup steps.
 *
 * Usage: node scripts/uninstall-codex-plugin.js
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

// ============================
// Configuration
// ============================

const PLUGIN_NAME = "tencentdb-memory";
const MARKETPLACE_DIR = path.join(os.homedir(), ".agents", "plugins");
const MARKETPLACE_FILE = path.join(MARKETPLACE_DIR, "marketplace.json");
const PLUGIN_INSTALL_DIR = path.join(MARKETPLACE_DIR, PLUGIN_NAME);
const CODEX_CONFIG_FILE = path.join(os.homedir(), ".codex", "config.toml");
const PLUGIN_CONFIG_ID = `${PLUGIN_NAME}@local-codex-plugins`;
const MCP_SERVER_NAME = "tdai-memory";

// ============================
// Main
// ============================

function loadMarketplace() {
  if (!fs.existsSync(MARKETPLACE_FILE)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(MARKETPLACE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function printCleanupGuidance() {
  const isWindows = process.platform === "win32";
  process.stderr.write("\nManual cleanup steps:\n\n");

  if (isWindows) {
    process.stderr.write(
      "  1. Stop the Gateway process: close the terminal running the Gateway,\n",
    );
    process.stderr.write(
      "     or run: taskkill /F /IM node.exe  (caution: kills all Node.js processes)\n\n",
    );
    process.stderr.write(
      "  2. (Optional) Delete stored memory data:\n",
    );
    process.stderr.write(
      "     rmdir /s %USERPROFILE%\\.memory-tencentdb\n",
    );
    process.stderr.write(
      "     WARNING: This permanently deletes all stored memories and cannot be undone.\n",
    );
  } else {
    process.stderr.write(
      '  1. Stop the Gateway process: pkill -f "gateway/server.ts"\n\n',
    );
    process.stderr.write(
      "  2. (Optional) Delete stored memory data:\n",
    );
    process.stderr.write(
      "     rm -rf ~/.memory-tencentdb\n",
    );
    process.stderr.write(
      "     WARNING: This permanently deletes all stored memories and cannot be undone.\n",
    );
  }
}

function removeTomlSections(sectionPred) {
  if (!fs.existsSync(CODEX_CONFIG_FILE)) return 0;

  const lines = fs.readFileSync(CODEX_CONFIG_FILE, "utf-8").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let removed = 0;
  let skipping = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const isSection = /^\[.*\]$/.test(trimmed);
    if (isSection) {
      skipping = sectionPred(trimmed);
      if (skipping) {
        removed++;
        continue;
      }
    }
    if (!skipping) out.push(line);
  }

  fs.writeFileSync(CODEX_CONFIG_FILE, out.join("\n").replace(/\n*$/, "\n"), "utf-8");
  return removed;
}

function removeCodexConfig() {
  const removed = removeTomlSections((section) =>
    section === `[plugins."${PLUGIN_CONFIG_ID}"]` ||
    section.startsWith(`[plugins."${PLUGIN_CONFIG_ID}".`) ||
    section === `[mcp_servers."${MCP_SERVER_NAME}"]` ||
    section.startsWith(`[mcp_servers."${MCP_SERVER_NAME}".`) ||
    section.startsWith(`[hooks.state."${PLUGIN_CONFIG_ID}:`),
  );
  if (removed > 0) {
    console.log(`Removed ${removed} Codex config section(s) from ${CODEX_CONFIG_FILE}`);
  }
}

// --- Run ---

console.log(`Uninstalling ${PLUGIN_NAME} plugin…`);

const marketplace = loadMarketplace();

if (!marketplace || !marketplace.plugins) {
  console.log("No marketplace file found. Plugin was not installed.");
  printCleanupGuidance();
  process.exit(0);
}

const idx = marketplace.plugins.findIndex((p) => p.name === PLUGIN_NAME);

if (idx < 0) {
  console.log(
    `Plugin "${PLUGIN_NAME}" not found in marketplace. Nothing to remove.`,
  );
  printCleanupGuidance();
  process.exit(0);
}

// Remove the entry
marketplace.plugins.splice(idx, 1);
console.log(`Removed "${PLUGIN_NAME}" from marketplace.`);

if (marketplace.plugins.length === 0) {
  // Delete the marketplace file if empty
  fs.unlinkSync(MARKETPLACE_FILE);
  console.log(
    `Marketplace file deleted (no remaining plugins): ${MARKETPLACE_FILE}`,
  );
} else {
  // Preserve other plugins
  fs.writeFileSync(
    MARKETPLACE_FILE,
    JSON.stringify(marketplace, null, 2) + "\n",
    "utf-8",
  );
  console.log(
    `Marketplace preserved with ${marketplace.plugins.length} remaining plugin(s).`,
  );
}

// Try to remove via Codex CLI first (handles cache cleanup)
try {
  execSync(`codex plugin remove ${PLUGIN_NAME}@local-codex-plugins`, {
    stdio: "pipe",
    timeout: 15_000,
  });
  console.log(`Removed ${PLUGIN_NAME} via Codex CLI.`);
} catch {
  // CLI not available — manual cleanup
}

// Remove the copied plugin directory from marketplace root
if (fs.existsSync(PLUGIN_INSTALL_DIR)) {
  fs.rmSync(PLUGIN_INSTALL_DIR, { recursive: true, force: true });
  console.log(`Removed plugin directory: ${PLUGIN_INSTALL_DIR}`);
}

// Also remove from Codex cache if CLI didn't handle it
const cacheDir = path.join(
  os.homedir(),
  ".codex",
  "plugins",
  "cache",
  "local-codex-plugins",
  PLUGIN_NAME,
);
if (fs.existsSync(cacheDir)) {
  fs.rmSync(cacheDir, { recursive: true, force: true });
  console.log(`Removed plugin cache: ${cacheDir}`);
}

removeCodexConfig();
printCleanupGuidance();
console.log("Uninstall complete.");
