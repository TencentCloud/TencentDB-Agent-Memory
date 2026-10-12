import { pathToFileURL } from "node:url";
import { PiOutboxStore } from "./pi-outbox-store.js";
import { createPiOutboxSender } from "./pi-outbox-sender.js";
import { PiOutboxWorker } from "./pi-outbox-worker.js";

const usage = "Usage: pi-outbox <list|redrive|flush|run> <directory> [record-id for redrive | --poll-ms <milliseconds> for run]";

/** Local operator entry point; no Pi lifecycle or gateway startup is changed. */
export async function runPiOutboxCommand(args: string[], env: NodeJS.ProcessEnv,
  output: (line: string) => void = console.log, signal?: AbortSignal): Promise<number> {
  const [command, directory, id] = args;
  const pollingOption = command === "run" && args.length === 4 && id === "--poll-ms";
  if (!directory || !["list", "redrive", "flush", "run"].includes(command)
    || (!pollingOption && args.length !== (command === "redrive" ? 3 : 2))) throw new Error(usage);
  const pollMs = pollingOption ? Number(args[3]) : 1_000;
  if (pollingOption && (!/^\d+$/.test(args[3]) || !Number.isSafeInteger(pollMs)
    || pollMs < 1 || pollMs > 86_400_000)) throw new Error("Polling interval must be between 1 ms and 24 hours");
  const store = new PiOutboxStore(directory);
  if (command === "list") {
    const state = await store.inspect();
    output(JSON.stringify(state, null, 2));
    return state.unreadable.length > 0 ? 2 : 0;
  }
  if (command === "redrive") {
    const redriven = await store.redrive(id);
    output(JSON.stringify({ id, redriven }));
    return redriven ? 0 : 1;
  }
  // Deliberate opt-in: old servers can ignore a key and still return success.
  // Never silently downgrade to unkeyed writes if the dependency is unavailable.
  if (env.TDAI_OUTBOX_IDEMPOTENCY !== "1142" || !env.TDAI_OUTBOX_ENDPOINT || !env.TDAI_OUTBOX_API_KEY) {
    throw new Error(`${command} requires TDAI_OUTBOX_ENDPOINT, TDAI_OUTBOX_API_KEY and TDAI_OUTBOX_IDEMPOTENCY=1142 for a verified compatible gateway`);
  }
  const sender = createPiOutboxSender({ endpoint: env.TDAI_OUTBOX_ENDPOINT,
    idempotencyContract: "1142", resolveApiKey: () => env.TDAI_OUTBOX_API_KEY! });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  try {
    const worker = new PiOutboxWorker(store, sender);
    if (command === "run") {
      let errors: string[] = [];
      output(JSON.stringify({ event: "started", pollMs }));
      await worker.run(controller.signal, result => {
        errors = result.errors;
        // Avoid an idle log every poll; never print payloads, URLs or credentials.
        if (result.delivered || result.retried || result.dead || result.lost
          || result.errors.length || result.unreadable.length) {
          output(JSON.stringify({ event: "pass", ...result }));
        }
      }, pollMs);
      const state = await store.inspect();
      const pending = state.entries.filter(entry => entry.state === "pending").length;
      const leased = state.entries.filter(entry => entry.state === "leased").length;
      const dead = state.entries.filter(entry => entry.state === "dead").length;
      output(JSON.stringify({ event: "stopped", pending, leased, dead, errors, unreadable: state.unreadable }));
      // Stopping a service is not a promise to drain its durable queue.
      return errors.length || dead || state.unreadable.length ? 2 : 0;
    }
    const result = await worker.flush(controller.signal);
    const state = await store.inspect();
    const remaining = state.entries.length;
    output(JSON.stringify({ ...result, remaining, unreadable: state.unreadable }, null, 2));
    return controller.signal.aborted || result.errors.length || result.unreadable.length
      || state.unreadable.length || remaining || result.retried || result.dead || result.lost ? 2 : 0;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    signal?.removeEventListener("abort", stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPiOutboxCommand(process.argv.slice(2), process.env).then(
    code => { process.exitCode = code; },
    () => { console.error(`${usage}\nCommand failed; verify arguments, directory permissions and gateway configuration.`); process.exitCode = 1; },
  );
}
