#!/usr/bin/env node
/**
 * Standalone CLI for Claude Code memory-tdai commands.
 *
 * Usage:
 *   npx tsx src/adapters/claude-code/cli.ts recall --text "hello" --session-key abc
 *   npx tsx src/adapters/claude-code/cli.ts capture < turn.json
 *   npx tsx src/adapters/claude-code/cli.ts mcp
 *   npx tsx src/adapters/claude-code/cli.ts configure
 *
 * After build, these become:
 *   memory-tdai claude-code-recall ...
 *   memory-tdai claude-code-capture ...
 *   memory-tdai claude-code-mcp
 *   memory-tdai claude-code-configure
 */

import fs from "node:fs";
import path from "node:path";

const TAG = "[memory-tdai-cli]";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    printHelp();
    process.exit(0);
  }

  switch (command) {
    case "recall":
    case "claude-code-recall": {
      const { claudeCodeRecall } = await import("./cli-recall.js");
      await claudeCodeRecall();
      break;
    }

    case "capture":
    case "claude-code-capture": {
      const { claudeCodeCapture } = await import("./cli-capture.js");
      await claudeCodeCapture();
      break;
    }

    case "mcp":
    case "claude-code-mcp": {
      const { createMcpServer } = await import("../mcp/server.js");
      const server = createMcpServer();
      await server.start();
      break;
    }

    case "configure":
    case "claude-code-configure": {
      await handleConfigure(args.slice(1));
      break;
    }

    case "generate-config": {
      await handleGenerateConfig(args.slice(1));
      break;
    }

    case "-h":
    case "--help":
      printHelp();
      break;

    default:
      console.error(`${TAG} Unknown command: ${command}`);
      console.error(`  Run with --help to see available commands.`);
      process.exit(1);
  }
}

// ============================
// Configure command
// ============================

async function handleConfigure(_args: string[]): Promise<void> {
  const { ClaudeCodeAdapter } = await import("./adapter.js");

  // Find .claude/settings.json
  let cwd = process.cwd();
  const { root } = path.parse(cwd);

  let settingsPath: string | null = null;
  let dir = cwd;
  for (let i = 0; i < 20; i++) {
    const candidate = path.join(dir, ".claude", "settings.json");
    if (fs.existsSync(candidate)) {
      settingsPath = candidate;
      break;
    }
    // Also check if .claude dir exists (we may need to create settings.json)
    const claudeDir = path.join(dir, ".claude");
    if (fs.existsSync(claudeDir)) {
      settingsPath = path.join(claudeDir, "settings.json");
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // If no .claude dir found, use cwd
  if (!settingsPath) {
    const claudeDir = path.join(cwd, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    settingsPath = path.join(claudeDir, "settings.json");
  }

  // Generate memory-tdai config section
  const mcpConfig = ClaudeCodeAdapter.generateSettingsJson({
    enableMcp: true,
    runner: "npx",
  });

  // Read existing settings
  let existing: Record<string, unknown> = {};
  try {
    const content = fs.readFileSync(settingsPath, "utf-8");
    existing = JSON.parse(content);
  } catch {
    // New file
  }

  // Merge — don't overwrite existing hooks/mcpServers
  const merged = { ...existing };

  if (mcpConfig.hooks) {
    merged.hooks = {
      ...(existing.hooks as Record<string, unknown> ?? {}),
      ...(mcpConfig.hooks as Record<string, unknown>),
    };
  }
  if (mcpConfig.mcpServers) {
    merged.mcpServers = {
      ...(existing.mcpServers as Record<string, unknown> ?? {}),
      ...(mcpConfig.mcpServers as Record<string, unknown>),
    };
  }

  // Write
  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  console.error(`\n✅ memory-tdai configuration written to ${settingsPath}`);
  console.error(`\nAdded entries:`);
  if (mcpConfig.hooks) {
    console.error(`  - preMessage hook: recall memories before each turn`);
    console.error(`  - postMessage hook: capture conversation after each turn`);
  }
  if (mcpConfig.mcpServers) {
    console.error(`  - MCP server: 5 tools (recall, capture, memory_search, conversation_search, session_end)`);
  }
  console.error(`\nRestart Claude Code for changes to take effect.`);
}

// ============================
// Generate config command
// ============================

async function handleGenerateConfig(_args: string[]): Promise<void> {
  const { ClaudeCodeAdapter } = await import("./adapter.js");
  const config = ClaudeCodeAdapter.generateSettingsJson();
  console.log(JSON.stringify(config, null, 2));
}

// ============================
// Help
// ============================

function printHelp(): void {
  console.error(`
┌─ memory-tdai Claude Code CLI ─────────────────────────────────────┐
│                                                                     │
│  COMMANDS:                                                          │
│                                                                     │
│  recall [--text <msg>] [--session-key <key>]                        │
│    Perform memory recall for a user message.                        │
│    Reads from stdin if --text not provided.                         │
│    Used by preMessage hook.                                         │
│                                                                     │
│  capture [--session-key <key>] [--messages-file <path>]             │
│    Capture a completed conversation turn.                           │
│    Reads from stdin if --messages-file not provided.                │
│    Used by postMessage hook.                                        │
│                                                                     │
│  mcp                                                                │
│    Start MCP stdio server (5 tools: recall, capture,                                      │
│    memory_search, conversation_search, session_end).                 │
│    Used by mcpServers config.                                       │
│                                                                     │
│  configure                                                          │
│    Auto-configure .claude/settings.json with hooks and MCP server.  │
│                                                                     │
│  generate-config                                                    │
│    Print the settings.json config fragment to stdout.               │
│                                                                     │
│  EXAMPLES:                                                          │
│    echo '{"text":"hello","sessionKey":"abc"}' | npx tsx cli.ts recall│
│    npx tsx cli.ts capture < turn.json                               │
│    npx tsx cli.ts mcp                                               │
│    npx tsx cli.ts configure                                         │
└─────────────────────────────────────────────────────────────────────┘
`);
}

// ─── CLI entry ────────────────────────────────────────────────────────────

function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalized = entry.replace(/\\/g, "/");
  return normalized.endsWith("cli.ts") ||
         normalized.endsWith("cli.js") ||
         normalized.endsWith("cli.mjs") ||
         normalized.endsWith("claude-code-cli");
}

if (isDirectEntry()) {
  main().catch((err) => {
    console.error(`${TAG} Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
