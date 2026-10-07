// Subprocess fixture for pi-outbox-contract.ts; never loaded by the proxy.
import { PiOutboxStore, type PiOutboxLease } from "../src/agent-adapters/pi-outbox-store.js";
import { PiOutboxWorker } from "../src/agent-adapters/pi-outbox-worker.js";
import { createPiOutboxSender } from "../src/agent-adapters/pi-outbox-sender.js";

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

const [mode, directory, endpoint, now] = process.argv.slice(2);
const clock = now ? () => Number(now) : Date.now;
const store = mode === "crash" ? new AckGapStore(directory, clock) : new PiOutboxStore(directory, clock);
const sender = createPiOutboxSender({ endpoint, idempotencyContract: "1142", resolveApiKey: () => "contract-test-key" });
const result = await new PiOutboxWorker(store, sender).flush();
process.send?.({ type: "complete", result });
process.disconnect?.();
