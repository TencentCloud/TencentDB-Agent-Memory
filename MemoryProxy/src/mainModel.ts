/**
 * Optional fixed upstream model for every request.
 *
 * TDAI_PROXY_MAIN_MODEL_FILE holds `{"model": "<upstream model id>"}`, written by the
 * effort page. While `model` is a non-empty string, chat, messages and responses
 * requests go to that model whatever the caller put in `model`; the handlers apply
 * it right after parsing the body, so routing, reasoning-effort control and the
 * logs all see the chosen model. An empty `model` or a missing file leaves requests
 * as sent. The file is re-read when its mtime changes, so no restart is needed.
 */

import { readFileSync, statSync } from "node:fs";

let cache: { path: string; mtimeMs: number; model: string | null } | null = null;

export function readMainModel(path = process.env.TDAI_PROXY_MAIN_MODEL_FILE?.trim()): string | null {
  if (!path) return null;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  if (cache?.path === path && cache.mtimeMs === mtimeMs) return cache.model;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { model?: unknown } | null;
    const model = typeof parsed?.model === "string" && parsed.model.trim() ? parsed.model.trim() : null;
    cache = { path, mtimeMs, model };
    return model;
  } catch {
    // A torn or invalid write keeps the last good value until the file changes again.
    return cache?.path === path ? cache.model : null;
  }
}

/**
 * Point the request at the main model, when one is set. Returns the model the
 * caller asked for when it was replaced, so the logs can keep it; null otherwise.
 */
export function applyMainModel(body: Record<string, unknown>): string | null {
  const model = readMainModel();
  if (!model) return null;
  const requested = typeof body.model === "string" ? body.model : "";
  body.model = model;
  return requested !== model ? requested : null;
}
