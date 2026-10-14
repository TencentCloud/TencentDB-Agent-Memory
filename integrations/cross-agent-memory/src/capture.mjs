import { inspectTurn } from "./privacy.mjs";
import {
  drainCaptureQueue,
  enqueueCapture,
  makeMemorySessionId
} from "./state-store.mjs";

const MAX_RETRY_BATCH = 3;
const DURABLE_SPOOL_RESERVE_MS = 700;

function isoTimestamp(value, fallback) {
  const timestamp = new Date(value ?? fallback);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : new Date(fallback).toISOString();
}

function isDuplicate(messages, queuedMessages) {
  if (!Array.isArray(messages) || !Array.isArray(queuedMessages) || queuedMessages.length === 0) return false;
  const used = new Set();
  return queuedMessages.every((queued) => {
    const index = messages.findIndex((candidate, candidateIndex) => {
      if (used.has(candidateIndex)) return false;
      return candidate?.role === queued.role &&
        candidate?.content === queued.content;
    });
    if (index < 0) return false;
    used.add(index);
    return true;
  });
}

function withinDeadline(operation, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve({ status: "timeout" });
  const controller = new AbortController();
  let timer;
  const operationResult = Promise.resolve()
    .then(() => operation(controller.signal))
    .then(
      (value) => ({ status: "fulfilled", value }),
      (error) => ({ status: "rejected", error })
    );
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ status: "timeout" });
    }, remaining);
  });
  return Promise.race([operationResult, timeout]).finally(() => clearTimeout(timer));
}

export async function captureTurn({
  gatewayClient,
  client,
  sourceSessionId,
  user,
  assistant,
  submittedAt,
  completedAt,
  runtimeDir,
  deadline
}) {
  try {
    const inspected = inspectTurn(user, assistant);
    if (inspected.skip) return { captured: false, queued: false, skipped: true };

    const now = new Date().toISOString();
    const messages = [
      { role: "user", content: inspected.user, timestamp: isoTimestamp(submittedAt, now) },
      { role: "assistant", content: inspected.assistant, timestamp: isoTimestamp(completedAt, now) }
    ];
    const memorySessionId = makeMemorySessionId(client, sourceSessionId);
    try {
      if (Number.isFinite(deadline)) {
        const write = await withinDeadline(
          (signal) => gatewayClient.addConversation(memorySessionId, messages, signal),
          deadline - DURABLE_SPOOL_RESERVE_MS
        );
        if (write.status !== "fulfilled") throw write.error ?? new Error("capture deadline");
      } else {
        await gatewayClient.addConversation(memorySessionId, messages);
      }
      return { captured: true, queued: false };
    } catch {
      const queued = await enqueueCapture(
        { memorySessionId, messages },
        { runtimeDir, deadline, deferConsolidation: Number.isFinite(deadline) }
      );
      return { captured: false, queued };
    }
  } catch {
    return { captured: false, queued: false };
  }
}

export async function retryQueuedCaptures({
  gatewayClient,
  retryBatchSize = 3,
  retryBudgetMs = 800,
  runtimeDir,
  deadline: aggregateDeadline
}) {
  const batchSize = Math.min(
    Number.isInteger(retryBatchSize) && retryBatchSize > 0 ? retryBatchSize : MAX_RETRY_BATCH,
    MAX_RETRY_BATCH
  );
  const budgetMs = Number.isFinite(retryBudgetMs) && retryBudgetMs > 0 ? retryBudgetMs : 800;
  const deadline = Math.min(
    Date.now() + budgetMs,
    Number.isFinite(aggregateDeadline) ? aggregateDeadline : Number.POSITIVE_INFINITY
  );
  let budgetExceeded = Date.now() >= deadline;
  if (budgetExceeded) {
    return { processed: 0, removed: 0, remaining: 0, budgetExceeded: true };
  }
  try {
    const result = await drainCaptureQueue(batchSize, async (record) => {
      if (Date.now() >= deadline) {
        budgetExceeded = true;
        return false;
      }

      const query = await withinDeadline(
        (signal) => gatewayClient.queryConversation(record.memorySessionId, 20, signal),
        deadline
      );
      if (query.status === "timeout") {
        budgetExceeded = true;
        return false;
      }
      if (query.status === "fulfilled" && isDuplicate(query.value?.messages, record.messages)) return true;

      const write = await withinDeadline(
        (signal) => gatewayClient.addConversation(record.memorySessionId, record.messages, signal),
        deadline
      );
      if (write.status === "timeout") {
        budgetExceeded = true;
        return false;
      }
      return write.status === "fulfilled";
    }, { runtimeDir, deadline });

    return {
      processed: result.processed,
      removed: result.removed,
      remaining: result.remaining,
      budgetExceeded
    };
  } catch {
    return { processed: 0, removed: 0, remaining: 0, budgetExceeded };
  }
}
