/** Authenticated, tenant-scoped filesystem export; no format conversion or indexing. */
import { Hono } from "hono";
import { join } from "node:path";
import { isValidIdSegment, wrapError, wrapOk } from "../api-helpers.js";
import { verifyBearer } from "../middleware/auth.js";
import { exportBundle, BundleExportError } from "../engines/wiki/okf-bundle-export.js";
import type { WikiService } from "../store/wiki-service.js";
const MAX_REQUEST_BYTES = 32 * 1024;
class InputError extends Error {
  constructor(public readonly status: 400 | 413 | 415, message: string) { super(message); }
}
async function input(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new InputError(415, "Expected application/json");
  const declared = request.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_REQUEST_BYTES) {
    void request.body?.cancel().catch(() => {}); throw new InputError(413, "Export request exceeds 32 KiB");
  }
  const reader = request.body?.getReader(); if (!reader) throw new InputError(400, "Invalid export request");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) { void reader.cancel().catch(() => {}); throw new InputError(413, "Export request exceeds 32 KiB"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes))); }
  catch { throw new InputError(400, "Invalid export request"); }
}

export function createOkfExportRoutes(service: WikiService, serviceKey: string): Hono {
  const app = new Hono();
  app.post("/export", async (c) => {
    // Unlike existing read-only routes, complete-file export always requires a key.
    if (!serviceKey) return c.json(wrapError(503, "Configure service authentication before exporting Wikis"), 503);
    if (!verifyBearer(c.req.header("authorization"), serviceKey)) return c.json(wrapError(401, "Valid service key required"), 401);
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "Valid service identity required"), 400);
    try {
      const body = await input(c.req.raw);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new InputError(400, "Invalid export request");
      const { team_id: team, wiki_id: wiki } = body as Record<string, unknown>;
      if (!isValidIdSegment(team) || !isValidIdSegment(wiki)) throw new InputError(400, "Valid team and Wiki identities required");
      const row = service.get(serviceId, team, wiki);
      if (!row) return c.json(wrapError(404, "Wiki not found"), 404);
      if (row.status === "pending" || row.status === "processing") return c.json(wrapError(409, "Wiki is processing"), 409);
      const files = exportBundle(join(service.dirFor(serviceId, team, wiki), "wiki"));
      return c.json(wrapOk({ files }));
    } catch (error) {
      if (error instanceof InputError) return c.json(wrapError(error.status, error.message), error.status);
      if (error instanceof BundleExportError) {
        if (error.kind === "filesystem") return c.json(wrapError(409, "Unsafe or unavailable Wiki filesystem state"), 409);
        return c.json(wrapError(400, "Invalid export paths or transport limits"), 400);
      }
      return c.json(wrapError(500, "Internal export error"), 500);
    }
  });
  return app;
}
