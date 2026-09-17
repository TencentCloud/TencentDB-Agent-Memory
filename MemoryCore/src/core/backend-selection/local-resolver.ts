/**
 * `LocalBackendResolver` (P8 / 完整实现设计 §5.3.1): resolve from process
 * parameters/env — the resolver used for standalone deployments and as the
 * pre-Shark behavior of service deployments.
 *
 * Fallback semantics (定稿 2026-08-31):
 * - no explicit override → per-deploy-mode default
 *   (standalone: sqlite+local; service: tcvdb+cos — byte-identical to today's
 *   behavior, N1);
 * - source throws / returns nothing → fail-fast (resolveVdb/resolveMongo/
 *   resolveCos already throw or return null; never silently fall to sqlite).
 *
 * `storeMode` / `fileStore` are the process-level explicit overrides
 * (STORE_MODE / FILE_STORE_MODE). After P9 they degrade from "the only
 * switch" to "local-mode explicit override parameters".
 */

import type {
  BackendConfigSource,
  BackendResolution,
  BackendResolver,
  DbChoice,
  DbKind,
  FsChoice,
  FsKind,
  FsOthersChoice,
  FsOthersKind,
} from "./types.js";
import { BackendResolutionError, validateResolution } from "./validate.js";

export interface LocalBackendResolverDeps {
  deployMode: "standalone" | "service";
  /** STORE_MODE explicit override; undefined → per-mode default. */
  storeMode?: DbKind | undefined;
  /** FILE_STORE_MODE explicit override; undefined → per-mode default. */
  fileStore?: FsKind | undefined;
  /**
   * FILE_STORE_OTHERS explicit override (only meaningful with
   * fileStore="rowfs"); undefined → per-mode default (standalone → local,
   * service → cos). The TCS mongofs default is derived by the future
   * TcsResolver, not here.
   */
  fileStoreOthers?: FsOthersKind | undefined;
  source: BackendConfigSource;
}

export class LocalBackendResolver implements BackendResolver {
  private readonly deps: LocalBackendResolverDeps;

  constructor(deps: LocalBackendResolverDeps) {
    this.deps = deps;
  }

  async resolve(instanceId: string): Promise<BackendResolution> {
    const db = await this.resolveDb(instanceId);
    const fs = await this.resolveFs();
    const resolution: BackendResolution = { db, fs };
    validateResolution(resolution);
    return resolution;
  }

  private async resolveDb(instanceId: string): Promise<DbChoice> {
    const kind: DbKind =
      this.deps.storeMode ?? (this.deps.deployMode === "service" ? "tcvdb" : "sqlite");
    switch (kind) {
      case "sqlite":
        return { kind, conn: null };
      case "tcvdb":
        return { kind, conn: await this.deps.source.resolveVdb(instanceId) };
      case "mongodb":
        return { kind, conn: await this.deps.source.resolveMongo(instanceId) };
    }
  }

  private async resolveFs(): Promise<FsChoice> {
    // Env surface (FILE_STORE_MODE / FILE_STORE_OTHERS) → two-axis model
    // (两轴模型定稿 §5 映射): local/cos are single-backend forms
    // (profile=files, the others leg serves every key); rowfs is the
    // composite form (profile=rows + an others leg).
    const mode: FsKind =
      this.deps.fileStore ?? (this.deps.deployMode === "service" ? "cos" : "local");
    switch (mode) {
      case "local":
        return { profile: "files", others: { kind: "local", conn: null } };
      case "cos":
        return { profile: "files", others: await this.resolveCosOthers() };
      case "rowfs": {
        const othersKind: FsOthersKind =
          this.deps.fileStoreOthers ??
          (this.deps.deployMode === "service" ? "cos" : "local");
        switch (othersKind) {
          case "local":
            return { profile: "rows", others: { kind: "local", conn: null } };
          case "mongofs":
            return { profile: "rows", others: { kind: "mongofs", conn: null } };
          case "cos":
            return { profile: "rows", others: await this.resolveCosOthers() };
        }
      }
    }
  }

  private async resolveCosOthers(): Promise<FsOthersChoice> {
    const conn = await this.deps.source.resolveCos();
    if (!conn) {
      throw new BackendResolutionError(
        `fs others="cos" but the config source returned null COS config — ` +
          `service mode requires COS credentials (or set FILE_STORE_MODE=local/rowfs explicitly).`,
      );
    }
    return { kind: "cos", conn };
  }
}
