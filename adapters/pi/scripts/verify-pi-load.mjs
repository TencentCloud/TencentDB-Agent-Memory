import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const adapterRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const piEntry = join(adapterRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");

if (!existsSync(piEntry)) {
  console.error("Pi development dependency is missing. Run npm ci first.");
  process.exit(1);
}

const piArgs = ["--mode", "rpc", "--no-session", "--offline", "--no-extensions", "-e", adapterRoot];
const child = spawn(
  process.execPath,
  [piEntry, ...piArgs],
  { cwd: adapterRoot, stdio: ["pipe", "pipe", "pipe"] },
);

let buffer = "";
let completed = false;
const timeout = setTimeout(() => finish(new Error("Timed out waiting for Pi to load the extension")), 15_000);

function finish(error) {
  if (completed) return;
  completed = true;
  clearTimeout(timeout);
  child.stdin.end();
  if (error) {
    console.error(`Pi extension load verification failed: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  console.log("Pi extension load verified: /tdai-memory-setup and /tdai-memory-status are registered.");
}

function handleLine(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (event.type !== "response" || event.command !== "get_commands") return;
  if (!event.success) {
    finish(new Error(event.error ?? "get_commands request failed"));
    return;
  }
  const names = new Set(event.data.commands.map((command) => command.name));
  const missing = ["tdai-memory-setup", "tdai-memory-status"].filter((name) => !names.has(name));
  finish(missing.length === 0 ? undefined : new Error(`Missing command registrations: ${missing.map((name) => `/${name}`).join(", ")}`));
}

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? "";
  for (const line of lines) handleLine(line);
});
child.stderr.on("data", (chunk) => {
  if (!completed) finish(new Error(chunk.toString("utf8").trim() || "Pi wrote to stderr"));
});
child.on("error", finish);
child.stdin.write(`${JSON.stringify({ id: "verify", type: "get_commands" })}\n`);
