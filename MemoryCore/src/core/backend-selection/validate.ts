/**
 * `validateResolution` (P7 / 完整实现设计 §5.1.1 + D8): reject illegal or
 * incomplete resolutions before the assembly layer builds any connection.
 *
 * Two failure classes, deliberately distinct:
 * - `BackendCapabilityError` — the combination itself cannot work
 *   (e.g. `sqlite × rowfs`: sqlite has no profile rows to map);
 * - `BackendResolutionError` — the combination is legal but the resolution
 *   is incomplete (a conn that the kind requires is missing).
 */

import { BackendCapabilityError, PROFILE_ROW_METHODS } from "../store/profile-row-store.js";
import type { BackendResolution } from "./types.js";

export class BackendResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendResolutionError";
  }
}

export function validateResolution(resolution: BackendResolution): void {
  const { db, fs } = resolution;

  if (db.kind === "tcvdb" && !db.conn) {
    throw new BackendResolutionError(
      `db.kind="tcvdb" requires a VdbConfig conn — the config source returned nothing. ` +
        `Check the instance's Shark delivery (or VDB_* env vars in local mode).`,
    );
  }
  if (db.kind === "mongodb" && !db.conn) {
    throw new BackendResolutionError(
      `db.kind="mongodb" requires a MongoConfig conn — the config source returned nothing. ` +
        `Check the instance's Shark delivery (or MONGODB_* env vars in local mode).`,
    );
  }
  if (fs.others.kind === "cos" && !fs.others.conn) {
    throw new BackendResolutionError(
      `fs.others="cos" requires a CosConfig conn — the config source returned null. ` +
        `Check COS credential delivery (or COS_* env vars in local mode).`,
    );
  }

  // §5.1.1 + 两轴定稿（2026-09-02 收紧）: profile=rows maps files onto profile
  // rows, and mongodb is the only DB whose store implements the profile-row
  // methods — sqlite has no rows to map, tcvdb has not implemented them (the
  // assembly guard would fail-fast anyway). Reject both before assembly.
  if (fs.profile === "rows" && db.kind !== "mongodb") {
    throw new BackendCapabilityError({
      dbKind: db.kind,
      fsKind: "rowfs",
      missing: PROFILE_ROW_METHODS,
    });
  }

  // mongofs stores its chunks in the instance's own Mongo database — without
  // db.kind="mongodb" there is no database to land them in.
  if (fs.others.kind === "mongofs" && db.kind !== "mongodb") {
    throw new BackendResolutionError(
      `fs.others="mongofs" requires db.kind="mongodb" (got "${db.kind}") — ` +
        `MongoFS chunks live in the instance's own Mongo database. ` +
        `Use others "local"/"cos", or select db.kind="mongodb".`,
    );
  }
}
