import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hashCanonical } from "../core/canonical.js";
import type { AttemptJournalEvent, AttemptJournalEventType } from "./contracts.js";

export class AppendOnlyAttemptJournal {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly path: string) {}

  async read(): Promise<AttemptJournalEvent[]> {
    try { const text = await readFile(this.path, "utf8"); return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as AttemptJournalEvent); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }

  append(input: Omit<AttemptJournalEvent, "schemaVersion" | "sequence" | "eventId" | "previousEventHash" | "eventHash">): Promise<AttemptJournalEvent> {
    const operation = this.queue.then(async () => {
      const existing = await this.read();
      const sequence = existing.length + 1; const previousEventHash = existing.at(-1)?.eventHash ?? "GENESIS";
      const body = { schemaVersion: "direction-a.current-formal.attempt-journal.v1" as const, sequence,
        eventId: `journal-${sequence}-${hashCanonical({ input, previousEventHash }).slice(0, 16)}`, ...input, previousEventHash };
      const event: AttemptJournalEvent = { ...body, eventHash: hashCanonical(body) };
      await mkdir(dirname(this.path), { recursive: true });
      const handle = await open(this.path, "a");
      try { await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
      return event;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}

export function eventPayload(eventType: AttemptJournalEventType, payload: Record<string, unknown>): { eventType: AttemptJournalEventType; payload: Record<string, unknown> } { return { eventType, payload }; }
