/**
 * CCHostAdapter — Claude Code platform preset for StandaloneHostAdapter.
 *
 * Claude Code connects via MCP stdio → Gateway HTTP. The Gateway uses
 * StandaloneHostAdapter with `platform: "claude-code"` to tag memories
 * originating from Claude Code sessions.
 *
 * This is a thin preset — all actual adapter logic lives in StandaloneHostAdapter.
 */

import { StandaloneHostAdapter } from "../standalone/host-adapter.js";
import type { StandaloneHostAdapterOptions } from "../standalone/host-adapter.js";

export interface CCHostAdapterOptions extends Omit<StandaloneHostAdapterOptions, "platform"> {}

export class CCHostAdapter extends StandaloneHostAdapter {
  constructor(opts: CCHostAdapterOptions) {
    super({ ...opts, platform: "claude-code" });
  }
}
