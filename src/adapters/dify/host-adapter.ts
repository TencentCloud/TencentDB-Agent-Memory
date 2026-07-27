import { HostAdapterBase } from "../host-adapter-base.js";
import type { HostAdapterBaseOptions } from "../host-adapter-base.js";

export type { HostAdapterBaseOptions as DifyHostAdapterOptions };

export class DifyHostAdapter extends HostAdapterBase {
  readonly hostType = "dify" as const;
  protected readonly platformId = "dify";
}
