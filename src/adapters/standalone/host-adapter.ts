/**
 * StandaloneHostAdapter — HostAdapter for the TDAI Gateway (Hermes sidecar).
 *
 * Adds the `platform` option that lets the gateway label its RuntimeContext
 * (defaults to "gateway"); everything else comes from HostAdapterBase.
 */

import { HostAdapterBase } from "../host-adapter-base.js";
import type { HostAdapterBaseOptions } from "../host-adapter-base.js";

// ============================
// Options
// ============================

export interface StandaloneHostAdapterOptions extends HostAdapterBaseOptions {
  /** Platform label written into RuntimeContext (default "gateway"). */
  platform?: string;
}

// ============================
// StandaloneHostAdapter
// ============================

export class StandaloneHostAdapter extends HostAdapterBase {
  readonly hostType = "standalone" as const;
  protected readonly platformId: string;

  constructor(opts: StandaloneHostAdapterOptions) {
    super(opts);
    this.platformId = opts.platform ?? "gateway";
  }
}
