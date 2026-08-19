/**
 * Subprocess helper for the real cross-process outbox tests. Each invocation
 * runs under plain `node` (native type stripping), so it is a genuinely
 * independent OS process:
 *
 *   node outbox-child.ts enqueue <outboxDir> <sessionId>
 *     Writes a capture to disk and exits without flushing — a stand-in for Pi
 *     dying after enqueue but before the network send.
 *
 *   node outbox-child.ts flush <outboxDir> <targetUrl> [--ready f] [--wait-for g] [--deliver-gate d] [--lease-timeout ms]
 *     Recovers pending records and delivers each to <targetUrl> over HTTP.
 *     --ready writes a marker file once ready, --wait-for blocks until a gate
 *     file exists (used to make two processes race the flush at once).
 *     --deliver-gate blocks inside the delivery callback until a gate file
 *     exists (used to hold a claim while a second process flushes).
 *     --lease-timeout overrides the lease timeout on this process (used to
 *     shrink the window so a test can outlive it without waiting a minute).
 */
import { access, writeFile } from "node:fs/promises";
import { enqueueCapture, flushOutbox } from "../../src/outbox.ts";
import type { LoadedConfig } from "../../src/types.ts";

const config: LoadedConfig = {
  enabled: true,
  endpoint: "http://127.0.0.1:8420",
  serviceId: "default",
  teamId: "team-test",
  agentId: "agent-test",
  userId: "user-test",
  userKey: "sk-mem-test",
  gatewayApiKey: "gateway-test",
  timeoutMs: 1_000,
  rejectUnauthorized: true,
  captureTools: false,
  recall: { enabled: true, deadlineMs: 3_000, l0Limit: 4, l1Limit: 6, l2Limit: 2, maxChars: 12_000 },
  skills: { enabled: false, capture: true, runtimeTools: true, routingMode: "bm25", allowTeamSearch: false, includeFailedTools: false, maxMessageBytes: 32768, maxToolItems: 16, flushTimeoutMs: 1500 },
  sources: [],
  userKeySource: "test",
  gatewayApiKeySource: "test",
};

async function waitFor(file: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [mode, outboxDir, third] = args;
  if (!mode || !outboxDir) {
    throw new Error("usage: outbox-child <enqueue|flush> <outboxDir> <sessionId|targetUrl>");
  }

  if (mode === "enqueue") {
    const record = await enqueueCapture(config, third ?? "pi-session", [
      { role: "user", content: "persisted before the network send" },
    ], { directory: outboxDir });
    console.log(`ENQUEUED ${record.id}`);
    return;
  }

  if (mode === "flush") {
    const readyIndex = args.indexOf("--ready");
    const gateIndex = args.indexOf("--wait-for");
    const deliverGateIndex = args.indexOf("--deliver-gate");
    const leaseTimeoutIndex = args.indexOf("--lease-timeout");
    const ready = readyIndex === -1 ? undefined : args[readyIndex + 1];
    const gate = gateIndex === -1 ? undefined : args[gateIndex + 1];
    const deliverGate = deliverGateIndex === -1 ? undefined : args[deliverGateIndex + 1];
    const leaseTimeout = leaseTimeoutIndex === -1 ? undefined : Number(args[leaseTimeoutIndex + 1]);
    if (ready) await writeFile(ready, "ready");
    if (gate) await waitFor(gate);
    const targetUrl = third ?? "http://127.0.0.1:1";
    const result = await flushOutbox(config, async (record) => {
      if (deliverGate) await waitFor(deliverGate);
      const response = await fetch(targetUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: record.id, sessionId: record.sessionId }),
      });
      if (!response.ok) throw new Error(`deliver failed with ${response.status}`);
    }, {
      directory: outboxDir,
      ...(leaseTimeout === undefined ? {} : { leaseTimeoutMs: leaseTimeout }),
    });
    console.log(`FLUSH ${JSON.stringify(result)}`);
    return;
  }

  throw new Error(`unknown mode ${mode}`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
