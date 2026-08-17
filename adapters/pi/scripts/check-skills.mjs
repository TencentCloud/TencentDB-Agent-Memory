#!/usr/bin/env node
/**
 * Quick dogfood probe: list the skills the configured agent already has on a
 * running MemoryCore, so you can see whether skill extraction is live and
 * whether /tdai-memory-sync-skills has anything to pull.
 *
 * Reads the adapter's global config + user-key file; never prints the key.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { SkillClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";

const configPath = process.env.TDAI_MEMORY_CONFIG_FILE ?? join(homedir(), ".pi", "agent", "tdai-memory.json");
const config = JSON.parse(await readFile(configPath, "utf8"));

const userKey = config.userKeyFile ? (await readFile(config.userKeyFile, "utf8")).trim() : process.env.TDAI_MEMORY_USER_KEY;
if (!userKey) throw new Error("no user key found (config userKeyFile or TDAI_MEMORY_USER_KEY)");

const skill = new SkillClient({
  endpoint: config.endpoint ?? "http://127.0.0.1:8420",
  apiKey: config.gatewayApiKeyFile ? (await readFile(config.gatewayApiKeyFile, "utf8")).trim() : userKey,
  serviceId: config.serviceId ?? "default",
  teamId: config.teamId,
  agentId: config.agentId,
  userId: config.userId,
});

console.log(`Endpoint : ${config.endpoint}`);
console.log(`Agent    : ${config.agentId}`);
console.log(`Skills enabled in config: ${config.skills?.enabled ? "yes" : "no"}`);

try {
  const result = await skill.list();
  if (result.items.length === 0) {
    console.log("\nNo skills found yet for this agent.");
    console.log("Either skill extraction is off on this server, or no conversation");
    console.log("has tripped the archive threshold (40KB or 10 tool calls per session).");
  } else {
    console.log(`\nFound ${result.items.length} skill(s) already on the server:`);
    for (const item of result.items) {
      console.log(`- ${item.name} (v${item.version}) ${item.description ? "— " + item.description : ""}`);
    }
    console.log("\nRun /tdai-memory-sync-skills in Pi to pull them into native skills.");
  }
} catch (error) {
  console.log(`\nSkill listing failed: ${error instanceof Error ? error.message : String(error)}`);
  console.log("This usually means the server has skill support disabled (skill.enabled).");
}
