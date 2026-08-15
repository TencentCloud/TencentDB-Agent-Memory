#!/usr/bin/env node

/**
 * CLI entrypoint for removing legacy <relevant-memories> injections from
 * existing OpenClaw session JSONL history.
 */

import path from "node:path";
import {
  formatCleanSummary,
  runLegacyRecallCleanup,
} from "../../src/utils/legacy-recall-cleanup.js";

interface CliOptions {
  stateDir?: string;
  yes: boolean;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { yes: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dir" || arg === "--state-dir") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`);
      options.stateDir = value;
      i += 1;
    } else if (arg === "--yes") {
      options.yes = true;
    } else if (arg === "--dry-run") {
      options.yes = false;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: clean-legacy-recall-injection [options]",
      "",
      "Scan OpenClaw session JSONL files and remove legacy <relevant-memories>",
      "blocks that older memory-tencentdb versions left in user history.",
      "",
      "Options:",
      "  --dir <path>    OpenClaw state dir (default: OPENCLAW_STATE_DIR or ~/.openclaw)",
      "  --dry-run       Report only (this is the default)",
      "  --yes           Rewrite affected session files",
      "  --json          Print machine-readable JSON summary",
      "  --help          Show this help",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const summary = await runLegacyRecallCleanup({
    stateDir: options.stateDir ? path.resolve(options.stateDir) : undefined,
    dryRun: !options.yes,
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(formatCleanSummary(summary));
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[clean-legacy-recall-injection] ${message}\n`);
  process.exitCode = 1;
});