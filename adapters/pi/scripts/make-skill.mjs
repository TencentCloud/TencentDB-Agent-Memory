#!/usr/bin/env node
/**
 * Quick dogfood helper: force a skill to appear on the configured agent by
 * posting one skill-worthy conversation (a reusable build-OOM triage) that
 * trips the server's 40 KB archive threshold, then waiting for the review
 * model to extract a SKILL.md.
 *
 * Uses a one-off session id, so it never touches your real Pi sessions'
 * buffers. Afterwards run /tdai-memory-sync-skills in Pi to pull the skill
 * into native skills. Never prints the user key.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { SkillClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";

const configPath = process.env.TDAI_MEMORY_CONFIG_FILE ?? join(homedir(), ".pi", "agent", "tdai-memory.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const userKey = config.userKeyFile ? (await readFile(config.userKeyFile, "utf8")).trim() : process.env.TDAI_MEMORY_USER_KEY;
if (!userKey) throw new Error("no user key found");

const skill = new SkillClient({
  endpoint: config.endpoint ?? "http://127.0.0.1:8420",
  apiKey: config.gatewayApiKeyFile ? (await readFile(config.gatewayApiKeyFile, "utf8")).trim() : userKey,
  serviceId: config.serviceId ?? "default",
  teamId: config.teamId,
  agentId: config.agentId,
  userId: config.userId,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const oomBuildLog = [
  "vite v5.4.0 building for production...",
  "transforming modules...",
  ...Array.from({ length: 750 }, (_, i) => `transforming module ./src/components/Component${String(i).padStart(3, "0")}.vue ... (${i + 1}/750)`),
  "computing gzip size...",
  "[vite:build] 90 modules transformed.",
  "",
  "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
  " 1: 0xa1c7e0 node::FatalError(v8::Isolate*, char const*, v8::OOMDetails const&)",
  " 2: 0x8b1a30 v8::internal::V8::FatalProcessOutOfMemory(v8::Isolate*, char const*, bool)",
].join("\n");

const messages = [
  { role: "user", content: "My CI build keeps failing intermittently with an out-of-memory error at the vite build step. How do I fix it reliably?" },
  { role: "assistant", content: "Intermittent OOM during a bundler build usually means the build tool is running without a bounded heap. Let me capture the failing output first to confirm." },
  { role: "tool_call", content: JSON.stringify({ command: "npm run build 2>&1 | tail -c 60000" }), tool_call_id: "call-capture", tool_name: "bash" },
  { role: "tool_result", content: oomBuildLog, tool_call_id: "call-capture", tool_name: "bash" },
  { role: "tool_call", content: JSON.stringify({ command: "node -e \"console.log(process.env.NODE_OPTIONS || 'unset')\"" }), tool_call_id: "call-env", tool_name: "bash" },
  { role: "tool_result", content: "unset", tool_call_id: "call-env", tool_name: "bash" },
  { role: "assistant", content: "Confirmed: NODE_OPTIONS is unset, so vite inherits the default Node heap and can exhaust it on large builds. The reliable fix is to bound the heap in the build script so every future run is stable." },
  { role: "tool_call", content: JSON.stringify({ path: "package.json", old_string: '"build": "vite build"', new_string: '"build": "NODE_OPTIONS=--max-old-space-size=4096 vite build"' }), tool_call_id: "call-fix", tool_name: "edit" },
  { role: "tool_result", content: "patched package.json build script", tool_call_id: "call-fix", tool_name: "edit" },
  { role: "assistant", content: "Fixed and re-ran the build successfully. Reusable triage for an intermittent CI OOM at the build step: (1) confirm NODE_OPTIONS is unset and the build tool has no --max-old-space-size; (2) set NODE_OPTIONS to a bounded heap (e.g. --max-old-space-size=4096) in the build script; (3) persist it; (4) re-run the build to verify it no longer OOMs. Apply to any Node CI pipeline that intermittently hits the heap limit during bundling." },
];

const sessionId = `tdai-dogfood-${Date.now()}`;
console.log(`Posting one skill-worthy conversation to agent ${config.agentId} (session ${sessionId})...`);

const added = await skill.conversationAdd({
  session_id: sessionId,
  user_id: config.userId,
  team_id: config.teamId,
  agent_id: config.agentId,
  messages,
});
if (added.status !== "archived") {
  throw new Error(`conversation/add returned ${added.status}, expected "archived" (bytes threshold)`);
}
console.log(`Archived (task=${added.archived?.task_id ?? "?"}). Waiting for the review model to mine a skill...`);

const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  await sleep(5_000);
  const result = await skill.list();
  const match = result.items.find((item) => /oom|heap|node|build|triage/i.test(`${item.name} ${item.description ?? ""}`));
  if (match) {
    console.log(`\n✔ Skill produced: "${match.name}" (v${match.version})`);
    console.log(`  ${match.description ?? ""}`);
    console.log("\nNow run /tdai-memory-sync-skills in Pi to pull it into native skills.");
    process.exit(0);
  }
}
console.log("No skill appeared within 120s. Check that the server's skill extraction is working (see container logs).");
process.exit(1);
