/** Stateless native OKF preflight; no stored Wiki access or model invocation. */
import { Hono } from "hono";
import { isValidIdSegment, wrapError, wrapOk } from "../api-helpers.js";
import { validateBundle, BundleValidationError, type BundleFile } from "../engines/wiki/okf-bundle-validation.js";

const MAX_REQUEST_BYTES = 20 * 1024 * 1024;
class InputError extends Error {
  constructor(public readonly status: 400 | 413 | 415, message: string) { super(message); }
}
async function readInput(request: Request): Promise<unknown> {
  const media = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (media !== "application/json") throw new InputError(415, "Expected application/json");
  const cancel = () => { void request.body?.cancel().catch(() => {}); };
  const length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_REQUEST_BYTES) {
    cancel(); throw new InputError(413, "Request exceeds 20 MiB");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new InputError(400, "Expected a JSON object containing files");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) {
        void reader.cancel().catch(() => {});
        throw new InputError(413, "Request exceeds 20 MiB");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes))); }
  catch { throw new InputError(400, "Invalid JSON input"); }
}

/** Mounted below /wiki/okf, after the service's existing authentication middleware. */
export function createOkfValidationRoutes(): Hono {
  const app = new Hono();
  app.post("/validate", async (c) => {
    if (!isValidIdSegment(c.req.header("x-tdai-service-id"))) return c.json(wrapError(400, "Valid service identity header required"), 400);
    try {
      const body = await readInput(c.req.raw);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new InputError(400, "Expected a JSON object containing files");
      const result = validateBundle((body as { files?: unknown }).files as BundleFile[]);
      return c.json(wrapOk(result));
    } catch (error) {
      if (error instanceof InputError) return c.json(wrapError(error.status, error.message), error.status);
      if (error instanceof BundleValidationError) return c.json(wrapError(400, "Invalid OKF bundle"), 400);
      return c.json(wrapError(500, "Internal error during validation"), 500);
    }
  });
  return app;
}
