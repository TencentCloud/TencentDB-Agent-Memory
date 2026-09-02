import { OutboxError } from './outbox.js';

const idFor = (item) => item.version === 2 ? item.operation_id : item.capture_id;

export class OutboxDrainService {
  constructor({ outbox, now = () => new Date(), monotonicNow = () => Date.now() } = {}) {
    if (!outbox || typeof outbox.listDrainCandidates !== 'function'
      || typeof outbox.processOperation !== 'function'
      || typeof outbox.withDeliveryLaneUntil !== 'function'
      || typeof now !== 'function' || typeof monotonicNow !== 'function') {
      throw new OutboxError('Invalid drain dependencies');
    }
    this.outbox = outbox;
    this.now = now;
    this.monotonicNow = monotonicNow;
  }

  async drain({ maxItems = 50, concurrency = 4, budgetMs = 30_000 } = {}) {
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100
      || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8
      || !Number.isFinite(budgetMs) || budgetMs < 100 || budgetMs > 60_000) {
      throw new OutboxError('Invalid drain options');
    }
    const startedAt = this.monotonicNow();
    const deadline = startedAt + budgetMs;
    const summary = {
      selected: 0, processed: 0, acknowledged: 0, failed: 0,
      deferred: 0, manualReview: 0, durationMs: 0,
    };
    const candidates = await this.outbox.listDrainCandidates(deadline);
    const lanes = new Map();
    for (const item of candidates) {
      if (!lanes.has(item.session_id)) lanes.set(item.session_id, []);
      lanes.get(item.session_id).push(item);
    }
    const laneEntries = [...lanes.entries()];
    let laneIndex = 0;
    let stopped = false;
    let fatalError;

    const claim = () => {
      if (stopped || summary.selected >= maxItems || this.monotonicNow() >= deadline) return false;
      summary.selected += 1;
      return true;
    };
    const runLane = async ([sessionId, items]) => {
      if (summary.selected >= maxItems || this.monotonicNow() >= deadline) return;
      let entered = false;
      const laneOutcome = await this.outbox.withDeliveryLaneUntil(sessionId, deadline, async () => {
        entered = true;
        for (const item of items) {
          if (!claim()) return;
          if (item.manual_review === true) {
            summary.manualReview += 1;
            summary.deferred += 1;
            return;
          }
          if (item.next_retry_at !== null && Date.parse(item.next_retry_at) > this.now().getTime()) {
            summary.deferred += 1;
            return;
          }
          summary.processed += 1;
          try {
            const outcome = await this.outbox.processOperation(idFor(item), deadline);
            if (outcome === 'acknowledged') summary.acknowledged += 1;
            else if (outcome === 'failed') summary.failed += 1;
            else summary.deferred += 1;
            if (outcome !== 'acknowledged') return;
          } catch (error) {
            if (error instanceof OutboxError && error.corrupt) {
              summary.failed += 1;
              return;
            }
            throw error;
          }
        }
      });
      if (!entered && laneOutcome === 'deferred' && claim()) summary.deferred += 1;
    };
    const worker = async () => {
      while (!stopped) {
        const index = laneIndex;
        laneIndex += 1;
        if (index >= laneEntries.length) return;
        try {
          await runLane(laneEntries[index]);
        } catch (error) {
          if (fatalError === undefined) fatalError = error;
          stopped = true;
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(concurrency, laneEntries.length) },
      () => worker(),
    ));
    if (fatalError !== undefined) throw fatalError;
    summary.durationMs = Math.max(0, this.monotonicNow() - startedAt);
    return summary;
  }
}
