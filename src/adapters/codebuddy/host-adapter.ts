/**
 * CodeBuddyHostAdapter — CodeBuddy platform preset for StandaloneHostAdapter.
 *
 * CodeBuddy connects via MCP stdio → Gateway HTTP (reuses the same MCP server
 * as Claude Code). The Gateway uses StandaloneHostAdapter with
 * `platform: "codebuddy"` to tag memories originating from CodeBuddy sessions.
 *
 * This is a thin preset — all actual adapter logic lives in StandaloneHostAdapter.
 */

import { StandaloneHostAdapter } from "../standalone/host-adapter.js";
import type { StandaloneHostAdapterOptions } from "../standalone/host-adapter.js";

export interface CodeBuddyHostAdapterOptions extends Omit<StandaloneHostAdapterOptions, "platform"> {}

export class CodeBuddyHostAdapter extends StandaloneHostAdapter {
  constructor(opts: CodeBuddyHostAdapterOptions) {
    super({ ...opts, platform: "codebuddy" });
  }
}
