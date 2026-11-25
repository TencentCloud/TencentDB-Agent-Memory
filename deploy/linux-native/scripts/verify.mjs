import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
const environment = JSON.parse(readFileSync(join(root, "config", "environment.json"), "utf8"));
const proxy = JSON.parse(readFileSync(join(root, "config", "proxy.yaml"), "utf8"));
const targets = [
  ["Core", environment.Core.TDAI_GATEWAY_PORT],
  ["Knowledge", environment.Knowledge.PORT],
  ["Panel", environment.Panel.PORT],
  ["Proxy", proxy.server.port],
];
let failed = false;
for (const [name, port] of targets) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(10000) });
    const health = await response.json();
    const valid = response.ok && health.status === "ok" &&
      (name !== "Core" || health.stores.vectorStore) &&
      (name !== "Proxy" || health.storage.effective === "sqlite");
    if (!valid) throw new Error(JSON.stringify(health));
    console.log(`${name}: healthy (HTTP ${response.status})`);
  } catch (error) {
    failed = true;
    console.error(`${name}: unhealthy (${error.message})`);
  }
}
if (failed) process.exit(1);
