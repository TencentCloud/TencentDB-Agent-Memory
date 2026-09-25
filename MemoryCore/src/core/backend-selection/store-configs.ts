/**
 * Bridge from the selection layer to the existing StorePool call shape.
 *
 * StorePool.getStore still takes `(instanceId, vdbConfig, mongoConfig)` and
 * infers the kind from config presence; because a validated {@link DbChoice}
 * always carries exactly the conn its kind requires, the pool's inference
 * necessarily agrees with the explicit kind. P9 keeps the pool signature
 * unchanged to stay byte-equivalent with the legacy path; making the pool
 * consume DbChoice directly is a later mechanical cleanup.
 */

import type { MongoConfig, VdbConfig } from "../instance-config-provider.js";
import type { DbChoice } from "./types.js";

export interface StoreBackendConfigs {
  vdbConfig: VdbConfig | null;
  mongoConfig: MongoConfig | null;
}

export function dbChoiceToStoreConfigs(db: DbChoice): StoreBackendConfigs {
  switch (db.kind) {
    case "mongodb":
      return { vdbConfig: null, mongoConfig: db.conn };
    case "tcvdb":
      return { vdbConfig: db.conn, mongoConfig: null };
    case "sqlite":
      return { vdbConfig: null, mongoConfig: null };
  }
}
