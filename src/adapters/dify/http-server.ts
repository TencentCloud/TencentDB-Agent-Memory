import { HttpServerBase } from "../http-server-base.js";
import { DifyHostAdapter } from "./host-adapter.js";
import type { HostAdapter } from "../../core/types.js";
import type { HttpServerBaseOptions } from "../http-server-base.js";

export type { HttpServerBaseOptions as DifyHttpServerOptions };

export class DifyHttpServer extends HttpServerBase {
  protected createAdapter(): HostAdapter {
    return new DifyHostAdapter({ ...this.opts, logger: this.logger });
  }
}
