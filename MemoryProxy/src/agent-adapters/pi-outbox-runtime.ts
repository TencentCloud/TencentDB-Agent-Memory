import { mkdir, open, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { TdaiConfig } from "../types.js";
import type { DurableConversationWrite } from "../tdai/client.js";
import { PiOutboxStore, type PiOutboxInput } from "./pi-outbox-store.js";
import { createPiOutboxSender } from "./pi-outbox-sender.js";
import { PiOutboxWorker, type PiOutboxFlushResult } from "./pi-outbox-worker.js";

function options(config: TdaiConfig) {
  const outbox = config.piOutbox;
  if (!outbox?.enabled || typeof outbox.directory !== "string" || !isAbsolute(outbox.directory)
    || outbox.idempotencyContract !== "1142" || !config.endpoint || !config.apiKey) {
    throw new Error("Pi outbox requires an absolute directory, gateway credentials and idempotencyContract: '1142'");
  }
  return outbox;
}

/** Request-local memoization keeps successful batches stable across recorder retries. */
export function createPiConversationWrite(config: TdaiConfig, serviceId: string, turnKey: string,
  store = new PiOutboxStore(options(config).directory)): DurableConversationWrite {
  if (!/^[A-Za-z0-9._:-]{1,220}$/.test(turnKey)) throw new Error("Invalid Pi turn key");
  let snapshot: string | undefined;
  let inputs: PiOutboxInput[] = [];
  const published = new Map<number, Promise<unknown>>();
  return async (identity, batches) => {
    // Credentials are deliberately excluded from both the snapshot and the queue.
    const scope = { serviceId, teamId: identity.teamId, agentId: identity.agentId,
      userId: identity.userId, sessionId: identity.sessionId };
    const signature = JSON.stringify({ scope, taskId: identity.taskId, batches });
    if (snapshot !== undefined && snapshot !== signature) throw new Error("Pi turn content changed during local retry");
    if (snapshot === undefined) {
      snapshot = signature;
      inputs = batches.map((messages, index) => ({ scope, body: JSON.stringify({
        session_id: scope.sessionId, team_id: scope.teamId, agent_id: scope.agentId, user_id: scope.userId,
        task_id: identity.taskId, idempotency_key: batches.length === 1 ? turnKey : `${turnKey}.${index}`,
        messages,
      }) }));
    }
    for (let index = 0; index < inputs.length; index++) {
      let pending = published.get(index);
      if (!pending) {
        pending = store.enqueue(inputs[index]).catch(error => { published.delete(index); throw error; });
        published.set(index, pending);
      }
      await pending;
    }
  };
}

/** Start before serving requests; awaiting stop leaves unacknowledged records on disk. */
export async function startPiOutbox(config: TdaiConfig,
  report: (result: PiOutboxFlushResult | { error: true }) => void = () => {}) {
  if (!config.piOutbox?.enabled) return { stop: async () => {} };
  const { directory } = options(config);
  const sender = createPiOutboxSender({ endpoint: config.endpoint, idempotencyContract: "1142",
    resolveApiKey: () => config.apiKey });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const probe = join(directory, `${randomUUID()}.tmp`);
  const file = await open(probe, "wx", 0o600);
  try { await file.sync(); } finally { await file.close(); await unlink(probe); }
  const controller = new AbortController();
  const worker = new PiOutboxWorker(new PiOutboxStore(directory), sender);
  // A temporary directory/read failure must not permanently stop the service.
  const running = (async () => {
    while (!controller.signal.aborted) {
      try { await worker.run(controller.signal, report); }
      catch {
        report({ error: true });
        if (!controller.signal.aborted) {
          const { setTimeout } = await import("node:timers/promises");
          await setTimeout(1_000, undefined, { signal: controller.signal }).catch(() => {});
        }
      }
    }
  })();
  return { stop: async () => { controller.abort(); await running; } };
}
