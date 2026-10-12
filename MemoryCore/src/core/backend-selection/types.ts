/**
 * Backend selection layer (专项五 / 完整实现设计 §4.2) — types only.
 *
 * A resolution answers "which backend + which connection" for one instance,
 * per dimension (DB / FS). It carries no connection behavior; the assembly
 * layer (server.ts, P9) consumes it to instantiate stores/backends.
 *
 * `kind` is explicit — replacing today's implicit "whichever config is
 * non-empty" inference (store-pool.ts getStore). The discriminated unions
 * make illegal kind/conn pairings unrepresentable at compile time (D8
 * layer 1); `validateResolution` re-checks at runtime for data that crosses
 * process boundaries.
 */

import type { CosConfig, MongoConfig, VdbConfig } from "../instance-config-provider.js";

export type DbKind = "sqlite" | "tcvdb" | "mongodb";

/**
 * Env-surface vocabulary for `FILE_STORE_MODE` (两轴模型定稿 §5 映射的输入侧).
 * `rowfs` is the composite form: profile keys as rows + an others leg.
 */
export type FsKind = "local" | "cos" | "rowfs";

/**
 * Two-axis FS model (两轴模型定稿 2026-09-02): an instance's file plane is two
 * orthogonal questions, not one enum.
 *
 * - `profile`: do profile keys (`persona.md`, `scene_blocks/*.md`, i.e. L2/L3)
 *   stay files, or become rows in the DB store?
 * - `others`: which backend serves every other key (conversations/ archives,
 *   .metadata/ checkpoints, offload/ artifacts, skill resources, …)?
 *
 * `profile="files"` → the others backend serves ALL keys (single-backend
 * assembly, the pre-rowfs form). `profile="rows"` → CompositeStorageBackend(
 * ProfileRowStorageBackend, others). `rows` requires `db.kind="mongodb"`.
 */
export type FsProfileMode = "files" | "rows";

/**
 * The others-leg backend kind. `mongofs` is the TCS choice: it keeps every
 * byte in the instance's own Mongo database (zero disk), and is therefore
 * only legal when `db.kind === "mongodb"` (validate.ts).
 */
export type FsOthersKind = "local" | "cos" | "mongofs";

/**
 * sqlite/local/mongofs carry `conn: null` on purpose:
 * - sqlite/local connection info is process-level (dataDir/baseDir), not per-instance;
 * - mongofs reuses the DB dimension's MongoConfig (its chunks live in the same
 *   instance database as the memory store).
 */
export type DbChoice =
  | { kind: "sqlite"; conn: null }
  | { kind: "tcvdb"; conn: VdbConfig }
  | { kind: "mongodb"; conn: MongoConfig };

export type FsOthersChoice =
  | { kind: "local"; conn: null }
  | { kind: "cos"; conn: CosConfig }
  | { kind: "mongofs"; conn: null };

export interface FsChoice {
  profile: FsProfileMode;
  others: FsOthersChoice;
}

export interface BackendResolution {
  db: DbChoice;
  fs: FsChoice;
}

/**
 * Source of per-instance connection configs. Structurally matches
 * `InstanceConfigProvider` (which adds caching/fail-loud semantics), so the
 * provider can be passed directly while tests substitute a fake.
 */
export interface BackendConfigSource {
  resolveVdb(instanceId: string): Promise<VdbConfig>;
  resolveMongo(instanceId: string): Promise<MongoConfig>;
  resolveCos(): Promise<CosConfig | null>;
}

/**
 * The resolver is an interface with one implementation per config source:
 * - `LocalBackendResolver` — params/env (STORE_MODE / FILE_STORE_MODE), this PR;
 * - `SharkResolver` — per-instance Shark delivery (P12, blocked on the
 *   cross-repo descriptor protocol);
 * - `TcsResolver` — customer-premise Shark, same interface (P14).
 */
export interface BackendResolver {
  resolve(instanceId: string): Promise<BackendResolution>;
}
