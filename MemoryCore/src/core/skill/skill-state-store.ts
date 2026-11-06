import type { DatabaseSync } from "node:sqlite";
import type { Collection, Db, Filter } from "mongodb";

export interface SkillStateRecord {
  revision: number;
  value: unknown;
}

export interface SkillStateListOptions {
  limit?: number;
  /** Exclusive key cursor, normally the previous page's next value. */
  after?: string;
}

export interface SkillStatePage {
  items: Array<SkillStateRecord & { key: string }>;
  next?: string;
}

/**
 * Small JSON control records, isolated from memory state and skill bodies.
 * Call init before use; the caller owns the connected database and its lifetime.
 * Keys are nonempty, well-formed Unicode, at most 1024 UTF-8 bytes, without NUL.
 * Values must be plain JSON (no lossy coercions), at most 1 MiB encoded, depth <=100.
 * list uses binary key order, limit 1..1000 (default 100), and an exclusive cursor.
 * Pages are not snapshots: concurrent writes may change subsequent pages.
 * Conflicts return false; validation, corrupt data and database errors reject.
 * Revisions reset to 1 after remove + create: do not reuse keys while old writers live.
 */
export interface AtomicSkillStateStore {
  init(): Promise<void>;
  read(key: string): Promise<SkillStateRecord | null>;
  /** Ordered batch, including duplicates/null misses; at most 1000 keys, not a snapshot. */
  readMany?(keys: string[]): Promise<Array<SkillStateRecord | null>>;
  create(key: string, value: unknown): Promise<boolean>;
  compareAndSet(key: string, expectedRevision: number, value: unknown): Promise<boolean>;
  list(prefix: string, options?: SkillStateListOptions): Promise<SkillStatePage>;
  remove(key: string, expectedRevision: number): Promise<boolean>;
}

const MAX_JSON_BYTES = 1024 * 1024;

function validateKey(key: string, label = "key", allowEmpty = false): void {
  if (typeof key !== "string" || (!allowEmpty && key.length === 0) ||
      key.includes("\0") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(key) ||
      Buffer.byteLength(key, "utf8") > 1024) {
    throw new TypeError(`${label} must be well-formed Unicode without NUL, ${allowEmpty ? "0" : "1"}..1024 UTF-8 bytes`);
  }
}

function validateRevision(revision: number, increment = false): void {
  if (!Number.isSafeInteger(revision) || revision < 1 || (increment && revision === Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("revision must be a positive safe integer with room for any increment");
  }
}

function encodeJson(value: unknown): string {
  const ancestors = new Set<object>();
  function validate(current: unknown, depth: number): void {
    if (depth > 100) throw new RangeError("JSON depth must not exceed 100");
    if (current === null || typeof current === "string" || typeof current === "boolean") return;
    if (typeof current === "number" && Number.isFinite(current)) return;
    if (typeof current !== "object") throw new TypeError("Value must contain only JSON-compatible data");
    if (ancestors.has(current)) throw new TypeError("JSON value must not contain cycles");
    const array = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("JSON objects and arrays must have plain prototypes");
    }
    ancestors.add(current);
    const keys = Reflect.ownKeys(current);
    if (array && keys.length !== current.length + 1) {
      throw new TypeError("JSON arrays must not contain holes or extra properties");
    }
    for (const key of keys) {
      if (array && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
      if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor) ||
          (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= current.length))) {
        throw new TypeError("JSON properties must be enumerable string-keyed data properties");
      }
      validate(descriptor.value, depth + 1);
    }
    ancestors.delete(current);
  }
  validate(value, 0);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > MAX_JSON_BYTES) {
    throw new RangeError(`JSON value must not exceed ${MAX_JSON_BYTES} UTF-8 bytes`);
  }
  return json;
}

function decodeRecord(revision: number, json: string): SkillStateRecord {
  validateRevision(revision);
  if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > MAX_JSON_BYTES) {
    throw new TypeError("Stored JSON must be a string of at most 1048576 UTF-8 bytes");
  }
  // Parse errors are deliberately propagated; corruption is never a missing record.
  return { revision, value: JSON.parse(json) };
}

function validateBatchKeys(keys: string[]): string[] {
  if (!Array.isArray(keys) || keys.length > 1000) throw new RangeError("readMany batch must contain at most 1000 keys");
  const requested = [...keys];
  for (const key of requested) validateKey(key);
  return requested;
}

type StoredJson = { revision: number; value_json: string };

function orderedBatch(keys: string[], rows: Map<string, StoredJson>): Array<SkillStateRecord | null> {
  // Decode per result so duplicate inputs do not share mutable value references.
  return keys.map(key => {
    const row = rows.get(key);
    return row ? decodeRecord(row.revision, row.value_json) : null;
  });
}

function pagination(prefix: string, options: SkillStateListOptions = {}) {
  validateKey(prefix, "prefix", true);
  if (options.after !== undefined) validateKey(options.after, "after");
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError("limit must be an integer between 1 and 1000");
  }
  return { limit, after: options.after };
}

function page(items: SkillStatePage["items"], limit: number): SkillStatePage {
  if (items.length <= limit) return { items };
  const visible = items.slice(0, limit);
  return { items: visible, next: visible[visible.length - 1].key };
}

/** Every write is one SQLite statement, hence one atomic implicit transaction. */
export class SqliteSkillStateStore implements AtomicSkillStateStore {
  constructor(private readonly db: DatabaseSync) {}

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_control (
        key TEXT COLLATE BINARY PRIMARY KEY NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        value_json TEXT NOT NULL
      )
    `);
  }

  async read(key: string): Promise<SkillStateRecord | null> {
    validateKey(key);
    const row = this.db.prepare("SELECT revision, value_json FROM skill_control WHERE key = ?").get(key);
    return row ? decodeRecord(row.revision as number, row.value_json as string) : null;
  }

  async readMany(keys: string[]): Promise<Array<SkillStateRecord | null>> {
    keys = validateBatchKeys(keys);
    const unique = [...new Set(keys)];
    const found = new Map<string, StoredJson>();
    // Keep well below SQLite builds' parameter limits, without per-key queries.
    for (let offset = 0; offset < unique.length; offset += 250) {
      const batch = unique.slice(offset, offset + 250);
      const rows = this.db.prepare(`SELECT key, revision, value_json FROM skill_control WHERE key IN (${batch.map(() => "?").join(",")})`).all(...batch);
      for (const row of rows) found.set(row.key as string, { revision: row.revision as number, value_json: row.value_json as string });
    }
    return orderedBatch(keys, found);
  }

  async create(key: string, value: unknown): Promise<boolean> {
    validateKey(key);
    const json = encodeJson(value);
    // Only a conflict on this key is ignored; other database failures still throw.
    return this.db.prepare(`
      INSERT INTO skill_control (key, revision, value_json) VALUES (?, 1, ?)
      ON CONFLICT(key) DO NOTHING
    `).run(key, json).changes === 1;
  }

  async compareAndSet(key: string, expectedRevision: number, value: unknown): Promise<boolean> {
    validateKey(key);
    validateRevision(expectedRevision, true);
    const json = encodeJson(value);
    return this.db.prepare(`
      UPDATE skill_control SET revision = revision + 1, value_json = ?
      WHERE key = ? AND revision = ?
    `).run(json, key, expectedRevision).changes === 1;
  }

  async list(prefix: string, options?: SkillStateListOptions): Promise<SkillStatePage> {
    const { limit, after } = pagination(prefix, options);
    // substr is literal (unlike LIKE/GLOB), and SQLite length counts Unicode characters.
    const rows = this.db.prepare(`
      SELECT key, revision, value_json FROM skill_control
      WHERE key >= ? AND substr(key, 1, length(?)) = ? AND key > ?
      ORDER BY key COLLATE BINARY ASC LIMIT ?
    `).all(prefix, prefix, prefix, after ?? "", limit + 1);
    return page(rows.map(row => ({ key: row.key as string, ...decodeRecord(row.revision as number, row.value_json as string) })), limit);
  }

  async remove(key: string, expectedRevision: number): Promise<boolean> {
    validateKey(key);
    validateRevision(expectedRevision);
    return this.db.prepare("DELETE FROM skill_control WHERE key = ? AND revision = ?")
      .run(key, expectedRevision).changes === 1;
  }
}

type MongoStateDocument = { _id: string; revision: number; value_json: string };
const SIMPLE_COLLATION = { locale: "simple" };

/** MongoDB single-document writes need neither a replica set nor transactions. */
export class MongoSkillStateStore implements AtomicSkillStateStore {
  private readonly collection: Collection<MongoStateDocument>;

  constructor(db: Db) {
    this.collection = db.collection<MongoStateDocument>("skill_control", {
      readPreference: "primary",
      writeConcern: { w: "majority" },
    });
  }

  async init(): Promise<void> {
    // _id is the unique key; explicit creation also initializes an empty collection.
    await this.collection.createIndex({ _id: 1 }, { name: "_id_", collation: SIMPLE_COLLATION });
  }

  async read(key: string): Promise<SkillStateRecord | null> {
    validateKey(key);
    const row = await this.collection.findOne({ _id: key }, { collation: SIMPLE_COLLATION });
    return row ? decodeRecord(row.revision, row.value_json) : null;
  }

  async readMany(keys: string[]): Promise<Array<SkillStateRecord | null>> {
    keys = validateBatchKeys(keys);
    if (keys.length === 0) return [];
    const rows = await this.collection.find({ _id: { $in: [...new Set(keys)] } }, { collation: SIMPLE_COLLATION }).toArray();
    return orderedBatch(keys, new Map(rows.map(row => [row._id, row])));
  }

  async create(key: string, value: unknown): Promise<boolean> {
    validateKey(key);
    const json = encodeJson(value);
    try {
      await this.collection.insertOne({ _id: key, revision: 1, value_json: json });
      return true;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) return false;
      throw error;
    }
  }

  async compareAndSet(key: string, expectedRevision: number, value: unknown): Promise<boolean> {
    validateKey(key);
    validateRevision(expectedRevision, true);
    const json = encodeJson(value);
    const result = await this.collection.updateOne(
      { _id: key, revision: expectedRevision },
      { $set: { value_json: json }, $inc: { revision: 1 } },
      { collation: SIMPLE_COLLATION },
    );
    return result.modifiedCount === 1;
  }

  async list(prefix: string, options?: SkillStateListOptions): Promise<SkillStatePage> {
    const { limit, after } = pagination(prefix, options);
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const filter: Filter<MongoStateDocument> = {
      _id: { $regex: `^${escaped}`, ...(after === undefined ? {} : { $gt: after }) },
    };
    const rows = await this.collection.find(filter, { collation: SIMPLE_COLLATION })
      .sort({ _id: 1 }).limit(limit + 1).toArray();
    return page(rows.map(row => ({ key: row._id, ...decodeRecord(row.revision, row.value_json) })), limit);
  }

  async remove(key: string, expectedRevision: number): Promise<boolean> {
    validateKey(key);
    validateRevision(expectedRevision);
    const result = await this.collection.deleteOne(
      { _id: key, revision: expectedRevision }, { collation: SIMPLE_COLLATION },
    );
    return result.deletedCount === 1;
  }
}
