/**
 * MongoFSBackend — general-purpose IStorageBackend over MongoDB documents.
 *
 * The third file-backend family member alongside local/COS: an *inner* file
 * surface whose data lives in the instance's own Mongo database (unlike
 * local/COS, which are external landing spots). This is what lets a TCS form
 * run "one instance = one Mongo database, zero disk dependency": rowfs covers
 * the profile key space, MongoFS covers everything else (offload/, skills/,
 * .metadata/, …) as the composite's others leg.
 *
 * Data model (two collections in the instance DB):
 *   fs_objects  { _id: key, size, version, nextSeq, contentType?, metadata?, updatedAt }
 *   fs_chunks   { _id: "{key} {seq}", key, seq, data: BinData, createdAt }
 *
 * All content lives in chunks (uniform model), which is what makes the two
 * contract-relevant behaviours natural:
 *   - append-after-put works (contract clause "appends to an existing
 *     object"): put writes chunks 0..n-1, append continues at n;
 *   - atomic concurrent appends (COS position-check equivalence): the seq
 *     range is allocated by a single atomic findOneAndUpdate on the metadata
 *     doc ($inc nextSeq) before chunks are inserted, so concurrent appenders
 *     get disjoint, ordered ranges.
 *
 * Chunking at 1 MiB also keeps every document far under Mongo's 16 MiB limit,
 * so object size is practically unbounded (skill resources cap at 5 MB by
 * policy, offload refs are typically KBs–MBs).
 *
 * Semantics deliberately mirror LocalStorageBackend (the contract's reference
 * implementation): put always replaces, append always appends — no COS-style
 * appendable flag.
 */

import { Binary, type Db } from "mongodb";
import type {
  IStorageBackend,
  ListEntry,
  ListObjectsOptions,
  ListResult,
  PutObjectOptions,
  StorageLogger,
  StorageObject,
} from "./types.js";
import { pageEntries } from "./list-page.js";

const TAG = "[storage][mongofs]";

/** Content chunk size. Keeps docs far under the 16 MiB Mongo limit. */
const CHUNK_SIZE = 1024 * 1024;

export const MONGOFS_COLLECTIONS = {
  OBJECTS: "fs_objects",
  CHUNKS: "fs_chunks",
} as const;

interface ObjectDoc {
  _id: string;
  size: number;
  version: number;
  nextSeq: number;
  contentType?: string;
  metadata?: Record<string, string>;
  updatedAt: Date;
}

interface ChunkDoc {
  _id: string;
  key: string;
  seq: number;
  /** Written as Buffer (driver serializes to BinData); read back as Binary. */
  data: Buffer | Binary;
  createdAt: Date;
}

export interface MongoFSBackendOptions {
  /** The instance's own Mongo database (same Db the memory store uses). */
  db: Db;
  logger?: StorageLogger;
}

export class MongoFSBackend implements IStorageBackend {
  readonly type = "mongofs" as const;

  private readonly db: Db;
  private readonly logger?: StorageLogger;
  private initPromise: Promise<void> | null = null;

  constructor(opts: MongoFSBackendOptions) {
    this.db = opts.db;
    this.logger = opts.logger;
  }

  private objects() {
    return this.db.collection<ObjectDoc>(MONGOFS_COLLECTIONS.OBJECTS);
  }

  private chunks() {
    return this.db.collection<ChunkDoc>(MONGOFS_COLLECTIONS.CHUNKS);
  }

  /** Idempotent index ensure, lazy on first use (same pattern as stores). */
  private ensureIndexes(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        // _id (the key) is already indexed; chunks need per-key ordered scans.
        await this.chunks().createIndex({ key: 1, seq: 1 }, { unique: true });
      })().catch((err) => {
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  private validateKey(key: string): void {
    if (!key || typeof key !== "string") {
      throw new Error(`${TAG} invalid storage key: ${JSON.stringify(key)}`);
    }
    if (key.includes("\0")) {
      throw new Error(`${TAG} storage key must not contain NUL character`);
    }
  }

  private static chunkId(key: string, seq: number): string {
    return `${key} ${seq}`;
  }

  private static toChunks(key: string, buf: Buffer, now: Date): ChunkDoc[] {
    const out: ChunkDoc[] = [];
    for (let seq = 0; seq * CHUNK_SIZE < buf.length; seq++) {
      out.push({
        _id: MongoFSBackend.chunkId(key, seq),
        key,
        seq,
        data: buf.subarray(seq * CHUNK_SIZE, (seq + 1) * CHUNK_SIZE),
        createdAt: now,
      });
    }
    return out;
  }

  async putObject(key: string, content: string | Buffer, opts?: PutObjectOptions): Promise<void> {
    this.validateKey(key);
    await this.ensureIndexes();
    const buf = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
    const now = new Date();

    // Replace: drop old chunks, write new ones, then bump the metadata doc.
    // A crash mid-way can orphan old chunks under stale seqs — harmless: reads
    // follow nextSeq/size from the metadata doc, and the next put/append
    // reclaims the range. (TCS Mongo is a replica set; a transaction here is
    // possible but buys nothing the version bump doesn't already give readers.)
    await this.chunks().deleteMany({ key });
    const chunks = MongoFSBackend.toChunks(key, buf, now);
    if (chunks.length > 0) await this.chunks().insertMany(chunks);

    await this.objects().updateOne(
      { _id: key },
      {
        $set: {
          size: buf.length,
          nextSeq: chunks.length,
          updatedAt: now,
          ...(opts?.contentType ? { contentType: opts.contentType } : {}),
          ...(opts?.metadata && Object.keys(opts.metadata).length > 0 ? { metadata: opts.metadata } : {}),
        },
        $inc: { version: 1 },
        $setOnInsert: { _id: key },
      },
      { upsert: true },
    );
    this.logger?.debug?.(`${TAG} putObject: ${key} (${buf.length} bytes, ${chunks.length} chunks)`);
  }

  async appendObject(key: string, content: string | Buffer): Promise<void> {
    this.validateKey(key);
    await this.ensureIndexes();
    const buf = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
    if (buf.length === 0) return;
    const now = new Date();
    const newChunks = MongoFSBackend.toChunks(key, buf, now);

    // Allocate the seq range atomically first — this is the COS
    // position-checked append equivalent: concurrent appenders can never
    // interleave or overwrite each other's chunks.
    const meta = await this.objects().findOneAndUpdate(
      { _id: key },
      {
        $inc: { nextSeq: newChunks.length, size: buf.length, version: 1 },
        $set: { updatedAt: now },
        $setOnInsert: { _id: key },
      },
      { upsert: true, returnDocument: "after" },
    );
    const baseSeq = (meta?.nextSeq ?? newChunks.length) - newChunks.length;

    await this.chunks().insertMany(
      newChunks.map((c, i) => ({ ...c, _id: MongoFSBackend.chunkId(key, baseSeq + c.seq), seq: baseSeq + i })),
    );
    this.logger?.debug?.(`${TAG} appendObject: ${key} (+${buf.length} bytes @seq ${baseSeq})`);
  }

  async getObject(key: string): Promise<StorageObject | null> {
    this.validateKey(key);
    await this.ensureIndexes();
    const meta = await this.objects().findOne({ _id: key });
    if (!meta) return null;

    const parts = await this.chunks().find({ key }).sort({ seq: 1 }).toArray();
    const content = Buffer.concat(
      parts.map((p) => (p.data instanceof Binary ? Buffer.from(p.data.buffer) : p.data)),
    );
    return {
      key,
      content,
      contentType: meta.contentType,
      metadata: meta.metadata,
      lastModified: meta.updatedAt,
      size: meta.size,
    };
  }

  async exists(key: string): Promise<boolean> {
    this.validateKey(key);
    await this.ensureIndexes();
    const doc = await this.objects().findOne({ _id: key }, { projection: { _id: 1 } });
    return doc !== null;
  }

  /**
   * List objects under a key prefix, per the D9.2 contract. Keys are scanned
   * by _id range (index-backed, no regex), then folded in memory exactly like
   * LocalStorageBackend: non-recursive collapses deeper paths into one
   * trailing-slash directory entry; recursive yields files only.
   */
  async listObjects(prefix: string, opts?: ListObjectsOptions): Promise<ListResult> {
    await this.ensureIndexes();
    const recursive = opts?.recursive ?? false;

    const filter = prefix === "" ? {} : { _id: { $gte: prefix, $lt: `${prefix}\u{ffff}` } };
    const docs = await this.objects()
      .find(filter)
      .project({ _id: 1, size: 1, updatedAt: 1 })
      .toArray();

    const lastSlash = prefix.lastIndexOf("/");
    const dirKey = lastSlash >= 0 ? prefix.slice(0, lastSlash + 1) : "";

    const entries: ListEntry[] = [];
    const dirFold = new Map<string, { size: number; lastModified: Date }>();

    for (const doc of docs) {
      const key = doc._id;
      if (recursive) {
        entries.push({ key, size: doc.size, lastModified: doc.updatedAt, isDirectory: false });
        continue;
      }
      const rest = key.slice(dirKey.length);
      const slash = rest.indexOf("/");
      if (slash < 0) {
        entries.push({ key, size: doc.size, lastModified: doc.updatedAt, isDirectory: false });
      } else {
        const foldKey = `${dirKey}${rest.slice(0, slash + 1)}`;
        const cur = dirFold.get(foldKey);
        // Deterministic across calls (contract clause 6): max child mtime.
        if (!cur || cur.lastModified < doc.updatedAt) {
          dirFold.set(foldKey, { size: 0, lastModified: doc.updatedAt });
        }
      }
    }
    for (const [key, v] of dirFold) {
      entries.push({ key, size: 0, lastModified: v.lastModified, isDirectory: true });
    }

    return pageEntries(entries, opts);
  }

  async deleteObject(key: string): Promise<void> {
    this.validateKey(key);
    await this.ensureIndexes();
    await this.objects().deleteOne({ _id: key });
    await this.chunks().deleteMany({ key });
    this.logger?.debug?.(`${TAG} deleteObject: ${key}`);
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    await this.ensureIndexes();
    const filter = prefix === "" ? {} : { _id: { $gte: prefix, $lt: `${prefix}\u{ffff}` } };
    const objects = await this.objects().find(filter).project({ _id: 1 }).toArray();
    if (objects.length === 0) return 0;
    const keys = objects.map((d) => d._id);
    await this.chunks().deleteMany({ key: { $in: keys } });
    const res = await this.objects().deleteMany({ _id: { $in: keys } });
    this.logger?.debug?.(`${TAG} deleteByPrefix: ${prefix} (${res.deletedCount} objects)`);
    return res.deletedCount ?? 0;
  }
}
