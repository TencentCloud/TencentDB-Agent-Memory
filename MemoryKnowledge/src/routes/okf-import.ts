/** Authenticated native Wiki import and conservative interrupted-import recovery. */
import { Hono } from "hono";
import { isValidIdSegment, wrapError, wrapOk } from "../api-helpers.js";
import { verifyBearer } from "../middleware/auth.js";
import { BundleValidationError, BundleConflictError, type BundleFile } from "../engines/wiki/okf-bundle-import.js";
import type { WikiService } from "../store/wiki-service.js";
import type { WikiSourceManager } from "../engines/wiki/manager.js";
class InputError extends Error {
  constructor(public readonly status: 400 | 413 | 415, message: string) { super(message); }
}
async function input(request: Request, maxBytes: number): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new InputError(415, "Expected application/json");
  const declared = request.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    void request.body?.cancel().catch(() => {}); throw new InputError(413, "Request body exceeds operation limit");
  }
  const reader = request.body?.getReader(); if (!reader) throw new InputError(400, "Invalid request body");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { void reader.cancel().catch(() => {}); throw new InputError(413, "Request body exceeds operation limit"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes))); }
  catch { throw new InputError(400, "Invalid request body"); }
}

export function createOkfImportRoutes(service: WikiService, manager: WikiSourceManager, serviceKey: string): Hono {
  const app = new Hono();
  for (const operation of ["import", "recover"] as const) app.post("/" + operation, async c => {
    if (!serviceKey) return c.json(wrapError(503, "Configure service authentication before native Wiki writes"), 503);
    if (!verifyBearer(c.req.header("authorization"), serviceKey)) return c.json(wrapError(401, "Valid service key required"), 401);
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "Valid service identity required"), 400);
    try {
      const body = await input(c.req.raw, operation === "import" ? 20 * 1024 * 1024 : 32 * 1024);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new InputError(400, "Invalid request body");
      const { team_id: team, wiki_id: wiki, files, overwrite } = body as Record<string, unknown>;
      if (!isValidIdSegment(team) || !isValidIdSegment(wiki)) throw new InputError(400, "Valid team and Wiki identities required");
      if (operation === "import" && overwrite !== undefined && typeof overwrite !== "boolean") throw new InputError(400, "overwrite must be boolean");
      const row = service.get(serviceId, team, wiki);
      if (!row) return c.json(wrapError(404, "Wiki not found"), 404);
      const result = operation === "import" ? service.okfImport(serviceId, team, wiki, files as BundleFile[], overwrite === true) : service.okfRecover(serviceId, team, wiki);
      if (result === null) return c.json(wrapError(404, "Wiki not found"), 404);
      if (typeof result === "string") return c.json(wrapError(409, "Wiki is processing or requires recovery"), 409);
      if ("action" in result && result.action === "no_op") return c.json(wrapOk(result));
      try {
        manager.register({ name: wiki, path: service.dirFor(serviceId, team, wiki) });
        const indexed = manager.sync(wiki);
        const failed = indexed.status !== "ready" || !!indexed.error;
        service.okfIndexed(serviceId, team, wiki, indexed.pageCount ?? 0, failed ? "Internal indexing error" : undefined);
        if (failed) return c.json(wrapError(500, "Files saved; indexing failed and recovery is required"), 500);
      } catch {
        // No exception coercion: failures can contain sensitive paths or untrusted objects.
        service.okfIndexed(serviceId, team, wiki, 0, "Internal indexing error");
        return c.json(wrapError(500, "Files saved; indexing or finalization failed and recovery is required"), 500);
      }
      return c.json(wrapOk("action" in result ? { ...result, message: "Recovery completed and re-indexed successfully" } : result));
    } catch (error) {
      if (error instanceof InputError) return c.json(wrapError(error.status, error.message), error.status);
      if (error instanceof BundleValidationError) return c.json(wrapError(400, "Invalid native bundle"), 400);
      if (error instanceof BundleConflictError) return c.json(wrapError(409, "Wiki filesystem or recovery state conflicts with this operation"), 409);
      return c.json(wrapError(500, "Internal native import or recovery error"), 500);
    }
  });
  return app;
}
