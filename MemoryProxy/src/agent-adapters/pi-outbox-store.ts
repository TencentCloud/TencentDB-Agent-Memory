import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

/** Immutable delivery input. Credentials must be resolved at send time, not stored here. */
export interface PiOutboxInput {
  scope: { serviceId: string; teamId: string; agentId: string; userId: string; sessionId: string };
  /** Exact JSON request body, including idempotency_key and session_id. */
  body: string;
}

export interface PiOutboxRecord extends PiOutboxInput {
  version: 1;
  id: string;
}

export interface PiOutboxTurn {
  /** Stable completed-turn identity supplied by the eventual Pi integration. */
  key: string;
  messages: { role: "user" | "assistant"; content: string; timestamp?: string; recorded_at?: string }[];
}

/** No generated timestamps, truncation, or re-keying: retries must preserve semantics. */
export function preparePiOutboxInput(scope: PiOutboxInput["scope"], turn: PiOutboxTurn): PiOutboxInput {
  const input = { scope: { ...scope }, body: JSON.stringify({
    session_id: scope.sessionId, idempotency_key: turn.key,
    messages: turn.messages.map(message => ({ role: message.role, content: message.content,
      timestamp: message.timestamp, recorded_at: message.recorded_at })),
  }) };
  validateInput(input);
  return input;
}

export interface PiOutboxLease {
  record: PiOutboxRecord;
  token: string;
  expiresAt: number;
  attempts: number;
}

export type PiOutboxReason = "none" | "network" | "timeout" | "conflict" | "auth" | "rejected" | "server" | "malformed" | "exhausted";
export interface PiOutboxEntry {
  file: string;
  id: string;
  state: "pending" | "leased" | "dead";
  attempts: number;
  availableAt: number;
  reason: PiOutboxReason;
}
const REASONS = new Set<PiOutboxReason>(["none", "network", "timeout", "conflict", "auth", "rejected", "server", "malformed", "exhausted"]);

const RECORD_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseEntry(file: string): PiOutboxEntry | null {
  const p = file.split(".");
  if (!RECORD_NAME.test(p[0])) return null;
  if (p.length === 2 && p[1] === "json") return { file, id: p[0], state: "pending", attempts: 0, availableAt: 0, reason: "none" };
  const integer = (s: string) => /^\d+$/.test(s) && Number.isSafeInteger(Number(s));
  if (p.length === 5 && p[4] === "lease" && RECORD_NAME.test(p[1]) && integer(p[2]) && integer(p[3])) {
    return { file, id: p[0], state: "leased", availableAt: Number(p[2]), attempts: Number(p[3]), reason: "none" };
  }
  if (p.length === 5 && (p[4] === "pending" || p[4] === "dead") && integer(p[1]) && integer(p[2]) && REASONS.has(p[3] as PiOutboxReason)) {
    return { file, id: p[0], state: p[4], attempts: Number(p[1]), availableAt: Number(p[2]), reason: p[3] as PiOutboxReason };
  }
  return null;
}

function validateInput(input: PiOutboxInput): void {
  if (!input || !input.scope || ["serviceId", "teamId", "agentId", "userId", "sessionId"].some(
    (field) => typeof input.scope[field as keyof PiOutboxInput["scope"]] !== "string"
      || !input.scope[field as keyof PiOutboxInput["scope"]].trim(),
  )) throw new Error("Outbox requires a complete delivery scope");
  if (typeof input.body !== "string") throw new Error("Outbox body must be serialized JSON");
  const body = JSON.parse(input.body);
  if (!body || typeof body.idempotency_key !== "string"
    || !/^[A-Za-z0-9._:-]{1,256}$/.test(body.idempotency_key)
    || body.session_id !== input.scope.sessionId
    || !Array.isArray(body.messages) || body.messages.length === 0) {
    throw new Error("Outbox body requires a valid idempotency key, matching session and messages");
  }
  const allowed = new Set(["session_id", "idempotency_key", "messages", "team_id", "agent_id", "user_id", "task_id"]);
  if (Object.keys(body).some(key => !allowed.has(key))) throw new Error("Unsupported outbox request field");
  for (const [key, value] of [["team_id", input.scope.teamId], ["agent_id", input.scope.agentId], ["user_id", input.scope.userId]]) {
    if (body[key] !== undefined && body[key] !== value) throw new Error("Outbox body identity differs from scope");
  }
  if (body.messages.length > 100 || body.messages.some((m: { role?: unknown; content?: unknown } | null) =>
    !m || !["user", "assistant"].includes(String(m.role)) || typeof m.content !== "string" || m.content.length < 1 || m.content.length > 8192)) {
    throw new Error("Outbox requires 1-100 gateway messages with 1-8192 character content");
  }
  const messageFields = new Set(["role", "content", "timestamp", "recorded_at"]);
  for (const message of body.messages) {
    if (Object.keys(message).some(key => !messageFields.has(key))) throw new Error("Unsupported outbox message field");
    for (const field of ["timestamp", "recorded_at"]) {
      if (message[field] !== undefined && (typeof message[field] !== "string" || !Number.isFinite(Date.parse(message[field])))) {
        throw new Error("Invalid outbox message timestamp");
      }
    }
  }
  if (body.task_id !== undefined && (typeof body.task_id !== "string" || !body.task_id.trim())) throw new Error("Invalid outbox task identity");
}

/**
 * File state transitions only; sender and retry orchestration live in separate modules.
 * A fresh UUID identifies each enqueue; this API does not deduplicate turns.
 * Flush the file before publishing it, so recovery never reads a partial write.
 * This covers process crashes, not a portable power-loss durability guarantee
 * (directory metadata flushing differs between operating systems).
 */
export class PiOutboxStore {
  constructor(private readonly directory: string, private readonly now: () => number = Date.now) {}

  private expiration(ttlMs: number): number {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 86_400_000) {
      throw new Error("Lease duration must be between 1 ms and 24 hours");
    }
    return this.now() + ttlMs;
  }

  private leasePath(lease: PiOutboxLease): string {
    if (!RECORD_NAME.test(lease.record.id) || !RECORD_NAME.test(lease.token)
      || !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt < 0) {
      throw new Error("Invalid outbox lease");
    }
    if (!Number.isSafeInteger(lease.attempts) || lease.attempts < 1) throw new Error("Invalid outbox attempts");
    return join(this.directory, `${lease.record.id}.${lease.token}.${lease.expiresAt}.${lease.attempts}.lease`);
  }

  /** Atomic rename claims the record itself, not a separate lock file.
   * Renewals change the source filename: a stale reclaimer cannot steal a renewed
   * lease using an earlier directory snapshot. All consumers must share this API
   * and a local filesystem supporting atomic same-directory rename.
   */
  async claim(id: string, ttlMs: number = 30_000): Promise<PiOutboxLease | null> {
    if (!RECORD_NAME.test(id)) throw new Error("Invalid outbox record ID");
    this.expiration(ttlMs);
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    for (const name of names) {
      const entry = parseEntry(name);
      if (!entry || entry.id !== id || entry.state === "dead" || entry.availableAt > this.now()) continue;
      // Validate before taking ownership; corrupt entries remain inspectable.
      let record: PiOutboxRecord;
      try { record = JSON.parse(await readFile(join(this.directory, name), "utf8")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new Error("Unable to read or validate outbox record");
      }
      if (!record || record.version !== 1 || record.id !== id) throw new Error("Invalid outbox record");
      try { validateInput(record); } catch { throw new Error("Invalid outbox record"); }
      const lease = { record, token: randomUUID(), expiresAt: this.expiration(ttlMs), attempts: entry.attempts + 1 };
      try {
        await rename(join(this.directory, name), this.leasePath(lease));
        return lease;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return null;
  }

  /** Caller must retain the returned lease and renew before expiry while sending. */
  async renew(lease: PiOutboxLease, ttlMs: number = 30_000): Promise<PiOutboxLease | null> {
    const source = this.leasePath(lease);
    const renewed = { ...lease, token: randomUUID(), expiresAt: this.expiration(ttlMs) };
    if (lease.expiresAt <= this.now()) return null;
    try { await rename(source, this.leasePath(renewed)); return renewed; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** Return an owned record to pending after an unsuccessful delivery. */
  async release(lease: PiOutboxLease, delayMs: number = 0, reason: PiOutboxReason = "none"): Promise<boolean> {
    const source = this.leasePath(lease);
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 86_400_000 || !REASONS.has(reason)) throw new Error("Invalid retry policy");
    if (lease.expiresAt <= this.now()) return false;
    const target = `${lease.record.id}.${lease.attempts}.${this.now() + delayMs}.${reason}.pending`;
    try { await rename(source, join(this.directory, target)); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async deadLetter(lease: PiOutboxLease, reason: PiOutboxReason): Promise<boolean> {
    const source = this.leasePath(lease);
    if (!REASONS.has(reason) || reason === "none") throw new Error("Invalid failure reason");
    if (lease.expiresAt <= this.now()) return false;
    try {
      await rename(source, join(this.directory, `${lease.record.id}.${lease.attempts}.0.${reason}.dead`));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  /** Operator explicitly grants a fresh attempt budget, retaining the exact key/body. */
  async redrive(id: string): Promise<boolean> {
    if (!RECORD_NAME.test(id)) throw new Error("Invalid outbox record ID");
    const { entries } = await this.inspect();
    const entry = entries.find(item => item.id === id && item.state === "dead");
    if (!entry) return false;
    try {
      await rename(join(this.directory, entry.file), join(this.directory, `${id}.json`));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  /** Metadata only: suitable for operator output without exposing conversation text. */
  async inspect(): Promise<{ entries: PiOutboxEntry[]; unreadable: { file: string; reason: string }[] }> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], unreadable: [] };
      throw error;
    }
    const entries: PiOutboxEntry[] = [];
    const unreadable: { file: string; reason: string }[] = [];
    for (const name of names.sort()) {
      const entry = parseEntry(name);
      if (!entry) {
        if (!name.endsWith(".tmp")) unreadable.push({ file: name, reason: "Unrecognized outbox filename" });
        continue;
      }
      try {
        const record = JSON.parse(await readFile(join(this.directory, name), "utf8")) as PiOutboxRecord;
        if (!record || record.version !== 1 || record.id !== entry.id) throw new Error("Invalid record");
        validateInput(record);
        entries.push(entry);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") unreadable.push({ file: name, reason: "Unable to read or validate outbox record" });
      }
    }
    return { entries, unreadable };
  }

  async enqueue(input: PiOutboxInput): Promise<PiOutboxRecord> {
    validateInput(input);
    // Snapshot before the first await; caller mutations cannot change the record.
    const record: PiOutboxRecord = {
      version: 1, id: randomUUID(), scope: {
        serviceId: input.scope.serviceId, teamId: input.scope.teamId, agentId: input.scope.agentId,
        userId: input.scope.userId, sessionId: input.scope.sessionId,
      }, body: input.body,
    };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `${record.id}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, join(this.directory, `${record.id}.json`));
    return record;
  }

  /** Snapshot of pending records, including expired leases; claim before sending. */
  async recover(): Promise<{
    records: PiOutboxRecord[];
    unreadable: { file: string; reason: string }[];
  }> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], unreadable: [] };
      throw error;
    }
    const records: PiOutboxRecord[] = [];
    const unreadable: { file: string; reason: string }[] = [];
    for (const name of names.sort()) {
      const entry = parseEntry(name);
      if (!entry || entry.state === "dead" || entry.availableAt > this.now()) continue;
      try {
        const record = JSON.parse(await readFile(join(this.directory, name), "utf8")) as PiOutboxRecord;
        if (!record || record.version !== 1 || record.id !== entry.id) {
          throw new Error("Invalid outbox record version or identity");
        }
        validateInput(record);
        records.push(record);
      } catch (error) {
        // Keep bad records for inspection; never prevent healthy records recovering.
        // Avoid returning parser errors, which can include stored conversation text.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          unreadable.push({ file: name, reason: "Unable to read or validate outbox record" });
        }
      }
    }
    return { records, unreadable };
  }

  /** Delete only this lease's file after verified gateway success, never by record ID. */
  async acknowledge(lease: PiOutboxLease): Promise<boolean> {
    const source = this.leasePath(lease);
    if (lease.expiresAt <= this.now()) return false;
    try { await unlink(source); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}
