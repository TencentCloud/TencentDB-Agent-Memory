// Synthetic, loopback-only repro. No Pi identity, memory service or model is used.
// Run from Git Bash: node scripts/repro-utf8.mjs [path-to-bash]
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const path = "场景/中文-路径.md";
const payload = JSON.stringify({ path });
const received = [];
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  const body = JSON.parse(bytes.toString("utf8"));
  received.push({ path: body.path, matches: body.path === path, hex: bytes.toString("hex") });
  res.end(JSON.stringify({ code: 0, data: { path: body.path, content: body.path === path ? "synthetic scene" : null } }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

function bash(command) {
  return new Promise((resolve, reject) => {
    // Send the script as UTF-8 stdin so only Bash -> native curl argument conversion is tested.
    const child = spawn(process.argv[2] || "bash", ["--noprofile", "--norc", "-s"], { stdio: ["pipe", "pipe", "pipe"] });
    console.log(`Repro Bash PID=${child.pid}`);
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 10_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`Bash/curl exited ${code}: ${stderr}`));
    });
    child.stdin.end(command + "\n", "utf8");
  });
}

try {
  const url = `http://127.0.0.1:${server.address().port}/scenario/read`;
  const curl = `curl --silent --show-error --max-time 5 --noproxy '*' -H 'Content-Type: application/json' '${url}'`;
  console.log(JSON.stringify({ platform: process.platform, expectedPath: path, expectedHex: Buffer.from(payload).toString("hex") }));
  await bash(`${curl} -d '${payload}'`);
  console.log(JSON.stringify({ mode: "inline curl argument", ...received.at(-1) }));
  await bash(`printf '%s' '${payload}' | ${curl} --data-binary @-`);
  console.log(JSON.stringify({ mode: "UTF-8 stdin", ...received.at(-1) }));
  assert.equal(received.length, 2);
  assert.equal(received[1].matches, true, "The UTF-8 stdin control must preserve the path");
  console.log(received[0].matches ? "This shell/curl combination did not reproduce argument corruption." : "Reproduced: inline argument corrupted, UTF-8 stdin preserved.");
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
