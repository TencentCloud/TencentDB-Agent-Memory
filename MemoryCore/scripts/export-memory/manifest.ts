/**
 * Export bundle manifest — schema + validation for the portable memory
 * export format (issue #779, step 1: manifest/schema + read-only export).
 *
 * A manifest describes the assets inside a bundle (e.g. a ZIP archive):
 *   manifest.json
 *   conversations/YYYY-MM-DD.jsonl   (L0 chat memory)
 *   records/YYYY-MM-DD.jsonl         (L1 memory records)
 *
 * schema_version is fixed so importers can detect incompatible bundles.
 */

import { z } from "zod";

export const MANIFEST_SCHEMA_VERSION = "1.0.0";

/** Asset types covered by the memory system (step 1 exports chat-memory). */
export const memoryAssetTypeSchema = z.enum([
  "chat-memory",
  "skill",
  "llm-wiki",
  "code-graph",
]);
export type MemoryAssetType = z.infer<typeof memoryAssetTypeSchema>;

/** A single file inside the bundle with its integrity checksum. */
export const exportFileSchema = z.object({
  /** Path inside the bundle (e.g. "conversations/2026-08-01.jsonl"). */
  path: z.string().min(1),
  /** sha256 of the file content ("sha256:<64 hex>"). */
  checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/, "checksum must be sha256:<64 hex>"),
  /** Size in bytes. */
  size: z.number().int().nonnegative(),
});
export type ExportFile = z.infer<typeof exportFileSchema>;

/** One exported memory asset (e.g. a chat-memory bundle). */
export const exportAssetSchema = z.object({
  type: memoryAssetTypeSchema,
  /** Stable asset id (instance / scope the memory belongs to). */
  id: z.string().min(1),
  files: z.array(exportFileSchema).min(1),
});
export type ExportAsset = z.infer<typeof exportAssetSchema>;

/** Top-level export manifest. */
export const exportManifestSchema = z.object({
  schema_version: z.literal(MANIFEST_SCHEMA_VERSION),
  /** ISO-8601 export timestamp. */
  created_at: z.string(),
  /** Source instance id (optional). */
  source_instance_id: z.string().optional(),
  assets: z.array(exportAssetSchema),
});
export type ExportManifest = z.infer<typeof exportManifestSchema>;

/**
 * Validate a raw manifest object. Throws a ZodError with a precise path when
 * the manifest is malformed (unknown version, bad checksum format, ...).
 */
export function validateManifest(raw: unknown): ExportManifest {
  return exportManifestSchema.parse(raw);
}
