#!/usr/bin/env node
/**
 * Cross-platform postinstall hook.
 * OpenClaw runtime patch has been removed (PR #865) — the after_tool_call
 * hook now uses the official OpenClaw getSessionMessages API. See #851.
 */
console.log("[memory-tencentdb] postinstall: no OpenClaw runtime patch needed (see #851).");
