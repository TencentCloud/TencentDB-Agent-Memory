import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const adapterRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const piBinary = join(adapterRoot, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");

if (!existsSync(piBinary)) {
  console.error("Pi development dependency is missing. Run npm ci first.");
  process.exit(1);
}

const piArgs = ["--mode", "rpc", "--no-session", "--offline", "--no-extensions", "-e", adapterRoot];
const child = spawn(
  process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : piBinary,
  process.platform === "win32" ? ["/d", "/s", "/c", "call", piBinary, ...piArgs] : piArgs,
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
  console.log("Pi extension load verified: /tdai-memory-status is registered.");
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
  const commandRegistered = event.data.commands.some((command) => command.name === "tdai-memory-status");
  finish(commandRegistered ? undefined : new Error("/tdai-memory-status was not registered"));
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
