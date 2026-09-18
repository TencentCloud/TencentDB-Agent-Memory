import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const skill = {
  skill_id: "skl-e2e",
  name: "deploy-check",
  version: 1,
  content: "---\nname: deploy-check\ndescription: Check a deployment safely\n---\n\nRun the health check first.\n",
  script_paths: ["scripts/check.sh"],
};

function resolvePiCli() {
  if (process.env.PI_CLI_PATH && existsSync(process.env.PI_CLI_PATH)) return process.env.PI_CLI_PATH;
  const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const globalRoot = execFileSync(process.execPath, [npmCli, "root", "-g"], { encoding: "utf8" }).trim();
  const cli = join(globalRoot, "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  if (!existsSync(cli)) throw new Error(`Pi CLI was not found at ${cli}; set PI_CLI_PATH to its cli.js`);
  return cli;
}

function reply(response, data) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ code: 0, data }));
}

function readRequest(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function waitFor(predicate, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const remove = () => {
      const index = waitFor.listeners.indexOf(check);
      if (index >= 0) waitFor.listeners.splice(index, 1);
    };
    const timer = setTimeout(() => {
      remove();
      reject(new Error("timed out waiting for Pi RPC output"));
    }, timeoutMs);
    const check = (message) => {
      if (predicate(message)) {
        clearTimeout(timer);
        remove();
        resolve(message);
      }
    };
    waitFor.listeners.push(check);
  });
}
waitFor.listeners = [];

function publish(message) {
  for (const listener of [...waitFor.listeners]) listener(message);
}

const agentDir = await mkdtemp(join(tmpdir(), "tdai-pi-skill-sync-e2e-"));
const requests = [];
let pi;
const server = createServer(async (request, response) => {
  const body = await readRequest(request);
  const url = new URL(request.url, "http://127.0.0.1");
  requests.push({ path: url.pathname, body: JSON.parse(body), headers: request.headers });
  if (url.pathname.endsWith("/list")) return reply(response, { items: [skill] });
  if (url.pathname.endsWith("/get")) return reply(response, skill);
  if (url.pathname.endsWith("/files/read")) {
    return reply(response, { path: "scripts/check.sh", content: "echo healthy\n", encoding: "utf-8" });
  }
  response.writeHead(404).end();
});

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate fake Skill Bridge port");
  const proxyBase = `http://127.0.0.1:${address.port}`;
  const piArgs = [
    "--mode", "rpc",
    "--no-session",
    "--no-context-files",
    "--no-skills",
    "--extension", process.cwd(),
  ];
  pi = spawn(process.execPath, [resolvePiCli(), ...piArgs], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      TDAI_PROXY_URL: proxyBase,
      TDAI_SPACE_ID: "space-e2e",
      TDAI_USER_KEY: "user-key-e2e",
      TDAI_TEAM_ID: "team-e2e",
      TDAI_AGENT_ID: "agent-e2e",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  pi.stdout.setEncoding("utf8");
  pi.stdout.on("data", (chunk) => {
    stdout += chunk;
    for (;;) {
      const index = stdout.indexOf("\n");
      if (index < 0) break;
      const line = stdout.slice(0, index).replace(/\r$/, "");
      stdout = stdout.slice(index + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        publish(message);
        if (message.type === "extension_ui_request" && message.method === "confirm") {
          pi.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: message.id, confirmed: true })}\n`);
        }
      } catch {
        throw new Error(`Pi RPC emitted invalid JSON: ${line}`);
      }
    }
  });
  pi.stderr.setEncoding("utf8");
  pi.stderr.on("data", (chunk) => { stderr += chunk; });

  pi.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
  const commands = await waitFor((message) => message.type === "response" && message.id === "commands");
  if (!commands.success || !commands.data?.commands?.some((entry) => entry.name === "tdai-memory-sync-skills")) {
    throw new Error("Pi did not register /tdai-memory-sync-skills");
  }

  pi.stdin.write(`${JSON.stringify({ id: "sync", type: "prompt", message: "/tdai-memory-sync-skills" })}\n`);
  const synced = await waitFor((message) => message.type === "response" && message.id === "sync");
  if (!synced.success) throw new Error(`Pi rejected skill sync command: ${JSON.stringify(synced)}`);

  const skillMd = await readFile(join(agentDir, "skills", "deploy-check", "SKILL.md"), "utf8");
  const script = await readFile(join(agentDir, "skills", "deploy-check", "scripts", "check.sh"), "utf8");
  const marker = await readFile(join(agentDir, "skills", "deploy-check", "tdai-remote.json"), "utf8");
  if (!skillMd.includes("name: deploy-check") || script !== "echo healthy\n" || !marker.includes("skl-e2e")) {
    throw new Error("Pi sync did not install the expected native skill package");
  }

  if (requests.length !== 3 || requests.some((entry) => Object.keys(entry.body).some((key) => key.endsWith("_id") && key !== "skill_id"))) {
    throw new Error("sync made an unexpected Skill Bridge request or supplied caller-controlled identity");
  }
  if (requests.some((entry) => entry.headers["x-tdai-service-id"] !== "space-e2e" || entry.headers["authorization"] !== "Bearer user-key-e2e")) {
    throw new Error("sync did not carry the expected session credentials");
  }

  console.log("E2E passed: Pi registered the command and installed a session-scoped native skill.");
} finally {
  pi?.kill();
  server.close();
  await rm(agentDir, { recursive: true, force: true });
}
