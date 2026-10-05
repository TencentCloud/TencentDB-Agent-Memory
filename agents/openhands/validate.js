#!/usr/bin/env node
/**
 * Minimal config validation for the OpenHands adapter.
 *
 * Guards against the two failure modes that cost us the most debugging time:
 *
 *   1. A borrowed path prefix. The proxy classifies agentSource from the first
 *      path segment (MemoryProxy/src/handler.ts:665-667), so a /codebuddy/
 *      baseURL "works" while silently mislabelling every session, memory row
 *      and credit record OpenHands produces.
 *   2. A missing identity header on the FIRST turn. Header preselect only runs
 *      in the not-yet-initialised branch
 *      (MemoryProxy/src/session/codebuddy/init.ts:824-825); miss one header and
 *      the session parks at pending_asset_confirm (init.ts:1000) and the
 *      recovery branch (init.ts:1099) never calls resolvePresetIdentity again.
 *      The session is then permanently uninjected.
 *
 * OpenHands itself has no config file, so this reads the flat sample
 * `openhands.json` in this directory (or $TDAM_OPENHANDS_CONFIG) and lets
 * TDAM_* env vars override it, then optionally probes a live proxy.
 *
 * Usage: node agents/openhands/validate.js [path/to/openhands.json]
 *        TDAM_LIVE_PROBE=1 node agents/openhands/validate.js   # + network probes
 */
const fs = require("fs");
const path = require("path");

const configPath = path.resolve(
  process.argv[2] || process.env.TDAM_OPENHANDS_CONFIG || path.join(__dirname, "openhands.json"),
);

const REQUIRED_HEADERS = ["x-team-id", "x-agent-id", "x-task-id", "x-conversation-id"];
const PLACEHOLDER = /<[a-z0-9_ .-]*>/i;

let raw;
try {
  raw = fs.readFileSync(configPath, "utf8");
} catch (err) {
  console.error("FAIL: " + configPath);
  console.error("  - cannot read config file: " + err.message);
  process.exit(1);
}

const config = JSON.parse(raw);

// TDAM_* env wins: the shipped sample cannot contain real ids.
const baseURL = (process.env.TDAM_PROXY_BASE_URL || config.baseUrl || "").replace(/\/+$/, "");
const headers = Object.assign({}, config.headers);
const envMap = {
  "x-team-id": "TDAM_TEAM_ID",
  "x-agent-id": "TDAM_AGENT_ID",
  "x-task-id": "TDAM_TASK_ID",
  "x-conversation-id": "TDAM_CONVERSATION_ID",
  "x-tdai-service-id": "TDAM_SPACE_ID",
};
for (const [header, envName] of Object.entries(envMap)) {
  if (process.env[envName]) headers[header] = process.env[envName];
}

const failures = [];
const warnings = [];

if (!baseURL) {
  failures.push("baseUrl is missing (config `baseUrl` or TDAM_PROXY_BASE_URL)");
} else {
  let parsed;
  try {
    parsed = new URL(baseURL);
  } catch {
    parsed = null;
  }
  if (!parsed) {
    failures.push("baseUrl is not an absolute URL (got: " + baseURL + ")");
  } else {
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      failures.push("baseUrl protocol must be http/https (got: " + parsed.protocol + ")");
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    const agentSource = segments[0];
    if (segments.length < 2) {
      failures.push(
        "baseUrl must be /<agentSource>/<spaceId>[/v1] (got: " + parsed.pathname + ")",
      );
    } else if (agentSource !== "openhands") {
      failures.push(
        "baseUrl first segment must be `openhands` — agentSource is derived from it " +
          "(MemoryProxy/src/handler.ts:665-667), got: " + agentSource,
      );
    } else if (/\/codebuddy\//.test(baseURL)) {
      failures.push("baseUrl must NOT contain /codebuddy/ (got: " + baseURL + ")");
    } else if (segments[1] === "v1") {
      failures.push("baseUrl has no <spaceId> segment before /v1 (got: " + parsed.pathname + ")");
    } else if (parsed.pathname.indexOf("/v1") === -1) {
      warnings.push("baseUrl has no /v1 tail; LiteLLM appends /chat/completions, so verify the SDK version");
    }
    if (segments[2] && segments[1] === "v1") {
      warnings.push("unexpected segment order: " + parsed.pathname);
    }
  }
}

for (const header of REQUIRED_HEADERS) {
  const value = headers[header];
  if (!value) {
    failures.push(
      "header `" + header + "` is missing — all four must be present on the FIRST turn, " +
        "or the session parks at pending_asset_confirm (init.ts:824-825 vs :1099)",
    );
  } else if (PLACEHOLDER.test(value)) {
    failures.push("header `" + header + "` still holds a placeholder: " + value);
  }
}

// Optional but decisive for bridge calls: without it skill-bridge skips the
// persisted lookup entirely (skill-bridge.ts:503-506, gate :516-519 -> 40101 :526).
if (!headers["x-tdai-service-id"]) {
  warnings.push(
    "header `x-tdai-service-id` missing — skill/memory bridge calls cannot reach the " +
      "persisted binding (skill-bridge.ts:516-519) and will 40101",
  );
}

if (!process.env.TDAM_USER_KEY && !config.apiKey) {
  warnings.push("no user key set (TDAM_USER_KEY) — /whoami probe will be skipped");
}

if (/sk-(mem-)?[A-Za-z0-9]{12,}/.test(raw)) {
  failures.push(
    "config file appears to hold a real key (sk-mem-…); keep credentials in TDAM_USER_KEY " +
      "or an untracked file, never in committed config",
  );
}

function origin(url) {
  const idx = url.indexOf("://");
  if (idx === -1) return null;
  const slash = url.indexOf("/", idx + 3);
  return slash === -1 ? url : url.slice(0, slash);
}

async function liveProbe() {
  const base = origin(baseURL);
  if (!base) {
    console.error("SKIP: live probe — baseUrl is not absolute");
    return false;
  }
  try {
    const health = await fetch(base + "/health", { signal: AbortSignal.timeout(8000) });
    const body = await health.json().catch(() => ({}));
    console.log(
      "PROBE /health http=" + health.status +
        " status=" + body.status +
        " storage=" + (body.storage && body.storage.effective) +
        " (server.ts:85-105)",
    );
    const key = process.env.TDAM_USER_KEY || config.apiKey;
    if (key) {
      const whoami = await fetch(base + "/whoami", {
        headers: { Authorization: "Bearer " + key },
        signal: AbortSignal.timeout(8000),
      });
      // Never print the key, only the status; the body is a key id, not a secret.
      console.log("PROBE /whoami http=" + whoami.status + " (server.ts:108)");
    }
    return health.status === 200;
  } catch (err) {
    console.error("PROBE failed: " + err.name + " " + err.message);
    return false;
  }
}

if (failures.length > 0) {
  console.error("FAIL: " + configPath);
  for (const failure of failures) console.error("  - " + failure);
  for (const warning of warnings) console.error("  ~ " + warning);
  process.exit(1);
}

if (warnings.length > 0) {
  console.warn("WARN: " + configPath);
  for (const warning of warnings) console.warn("  ~ " + warning);
}

const okMessage = "OK: " + baseURL + " routes OpenHands through agentSource=openhands";

if (process.env.TDAM_LIVE_PROBE === "1") {
  // An explicitly requested probe that fails is a failure, not a footnote.
  liveProbe().then((probeOk) => {
    if (!probeOk) {
      console.error("FAIL: live probe (TDAM_LIVE_PROBE=1) did not reach /health");
      process.exit(1);
    }
    console.log(okMessage);
  });
} else {
  console.log(okMessage + " (set TDAM_LIVE_PROBE=1 to also probe /health and /whoami)");
}
