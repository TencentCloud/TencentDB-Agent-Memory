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
 * Usage: node adapters/opencode/validate.js [path/to/opencode.json]
 */
const fs = require("fs");
const path = require("path");

const configPath = path.resolve(process.argv[2] || path.join(__dirname, "opencode.json"));
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

const v1Provider = config.provider && config.provider["tencentdb-agent-memory"];
const v2Provider = config.providers && config.providers["tencentdb-agent-memory"];
const baseURL = v2Provider?.settings?.baseURL ?? v1Provider?.options?.baseURL;

const failures = [];
if (!v1Provider && !v2Provider) {
  failures.push("provider `tencentdb-agent-memory` is missing (provider for v1, providers for v2)");
}
if (v2Provider && v2Provider.package !== "@opencode/ai/providers/openai-compatible") {
  failures.push("v2 package must be @opencode/ai/providers/openai-compatible (chat/completions)");
}
if (!baseURL) {
  failures.push("provider `tencentdb-agent-memory` baseURL is missing");
} else {
  if (!/\/opencode\//.test(baseURL)) {
    failures.push("baseURL must contain /opencode/ (got: " + baseURL + ")");
  }
  if (/\/codebuddy\//.test(baseURL)) {
    failures.push("baseURL must NOT contain /codebuddy/ (got: " + baseURL + ")");
  }
}

if (failures.length > 0) {
  console.error("FAIL: " + configPath);
  for (const failure of failures) {
    console.error("  - " + failure);
  }
  process.exit(1);
}

console.log("OK: " + baseURL + " routes OpenCode through agentSource=opencode");
