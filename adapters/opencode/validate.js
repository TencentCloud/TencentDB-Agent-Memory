#!/usr/bin/env node
/**
 * Minimal config validation for the OpenCode adapter.
 *
 * Guards against routing OpenCode through the /codebuddy/ path family: the
 * proxy classifies agentSource from the first path segment, and OpenCode
 * requires the native `question`-based session-init form
 * (MemoryProxy/src/session/opencode/form.ts) that is only selected for
 * agentSource=opencode. A /codebuddy/ baseURL would make the adapter look
 * configured but fail during session initialization.
 *
 * Usage: node adapters/opencode/validate.js
 */
const fs = require("fs");
const path = require("path");

const configPath = path.join(__dirname, "opencode.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

const baseURL =
  config.provider &&
  config.provider["tencentdb-agent-memory"] &&
  config.provider["tencentdb-agent-memory"].options &&
  config.provider["tencentdb-agent-memory"].options.baseURL;

const failures = [];
if (!baseURL) {
  failures.push("provider `tencentdb-agent-memory`.options.baseURL is missing");
} else {
  if (!/\/opencode\//.test(baseURL)) {
    failures.push("baseURL must contain /opencode/ (got: " + baseURL + ")");
  }
  if (/\/codebuddy\//.test(baseURL)) {
    failures.push("baseURL must NOT contain /codebuddy/ (got: " + baseURL + ")");
  }
}

if (failures.length > 0) {
  console.error("FAIL: adapters/opencode/opencode.json");
  for (const failure of failures) {
    console.error("  - " + failure);
  }
  process.exit(1);
}

console.log("OK: " + baseURL + " routes OpenCode through agentSource=opencode");
