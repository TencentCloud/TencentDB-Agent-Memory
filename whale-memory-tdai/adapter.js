/**
 * Whale platform adapter for TDAI memory.
 *
 * Whale's hook payloads are the SDK's reference shape, so every default in
 * `BasePlatformAdapter` already matches:
 *   - recall:  { prompt, session_id }
 *   - capture: { prompt, last_assistant_text, session_id } (no transcript read)
 *   - output:  { decision: "pass", additional_context: "## Memory Context\n..." }
 *
 * The descriptor is therefore just a name — kept as its own module so the hook
 * shims and tests share a single definition.
 */

import { defineAdapter } from "./vendor/tdai-sdk/index.js";

export const adapter = defineAdapter({ name: "whale" });
