// Subprocess fixture for pi-outbox-contract.ts; never loaded by the proxy.
import { PiOutboxStore, type PiOutboxLease } from "../src/agent-adapters/pi-outbox-store.js";
import { PiOutboxWorker } from "../src/agent-adapters/pi-outbox-worker.js";
import { createPiOutboxSender } from "../src/agent-adapters/pi-outbox-sender.js";
import { once } from "node:events";

class AckGapStore extends PiOutboxStore {
  override async acknowledge(_lease: PiOutboxLease): Promise<boolean> {
    // The real HTTP sender has received and validated the gateway receipt.
    // Tell the parent to kill us before the local ACK can alter the lease file.
    process.send?.({ type: "ack-gap" });
    const keepAlive = setInterval(() => {}, 1_000);
    try { return await new Promise<boolean>(() => {}); }
    finally { clearInterval(keepAlive); }
  }
}

class RacingStore extends PiOutboxStore {
  override async recover() {
    const snapshot = await super.recover();
    // Both workers must see the same candidate before either may claim it.
    const start = once(process, "message", { signal: AbortSignal.timeout(15_000) });
    process.send?.({ type: "ready", records: snapshot.records.length });
    const [message] = await start;
    if (message.type !== "start") throw new Error("Expected race start barrier");
    return snapshot;
  }
}

const [mode, directory, endpoint, now, policy] = process.argv.slice(2);
const clock = now ? () => Number(now) : Date.now;
const store = mode === "crash" ? new AckGapStore(directory, clock)
  : mode === "race" ? new RacingStore(directory, clock) : new PiOutboxStore(directory, clock);
const sender = createPiOutboxSender({ endpoint, idempotencyContract: "1142", resolveApiKey: () => "contract-test-key" });
const result = await new PiOutboxWorker(store, sender, policy ? JSON.parse(policy) : {}).flush();
process.send?.({ type: "complete", result });
process.disconnect?.();
