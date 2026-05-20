#!/usr/bin/env node
import {
  ensureGateway,
  gatewayUrl,
  healthCheck,
  resolveTdaiRoot,
  startGatewayDetached,
  stopGateway,
  tdaiDataDir
} from "./lib.mjs";

const command = process.argv[2] || "status";

if (command === "status") {
  const healthy = await healthCheck();
  console.log(JSON.stringify({
    healthy,
    gatewayUrl: gatewayUrl(),
    tdaiRoot: resolveTdaiRoot(),
    dataDir: tdaiDataDir()
  }, null, 2));
} else if (command === "start") {
  const ok = await ensureGateway();
  console.log(ok ? "gateway ready" : "gateway unavailable");
  process.exit(ok ? 0 : 1);
} else if (command === "start-detached") {
  const ok = await startGatewayDetached();
  console.log(ok ? "gateway start requested" : "gateway start failed");
  process.exit(ok ? 0 : 1);
} else if (command === "stop") {
  const ok = await stopGateway();
  console.log(ok ? "gateway stop requested" : "no gateway pid found");
  process.exit(ok ? 0 : 1);
} else {
  console.error("Usage: node scripts/gateway.mjs [status|start|start-detached|stop]");
  process.exit(2);
}
