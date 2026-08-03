/**
 * storage.ts — backward-compat shim (Group D decomposition).
 * Re-exports the public API from `storage/*.ts` sub-modules. The 664-line
 * monolithic file was split into:
 *   - storage/session-registry.ts  (parseSessionKey, createStorageContext, ensureDirs, registerSession, lookupSessionId, listRegisteredSessions)
 *   - storage/sanitize.ts         (sanitizeText, sanitizeJsonLine, validateEntry, parseJsonlSafe, safeStringifyEntry, extractConfirmedIdsFromEntries, extractDeletedIdsFromEntries)
 *   - storage/jsonl-current.ts    (appendOffloadEntries, readOffloadEntries, rewriteOffloadEntries, markOffloadStatus)
 *   - storage/jsonl-all.ts        (readAllOffloadEntries, rewriteAllOffloadEntries, updateOffloadNodeIds)
 *   - storage/mmd-ops.ts          (MmdReplaceBlock, writeMmd, patchMmd, readMmd, deleteMmd, listMmds)
 *   - storage/ref-md.ts           (isoToFilename, writeRefMd, readRefMd)
 *   - storage/state-files.ts      (readStateFile, writeStateFile)
 *   - storage-shim-types.ts       (StorageContext interface)
 * Callers that did `import { ... } from "./storage.js"` continue to work.
 */
import { join } from "node:path";
import { homedir } from "node:os";

// Re-export StorageContext type (so callers can still do `import type { StorageContext } from "./storage.js"`)
export type { StorageContext } from "./storage-shim-types.js";

/** Default root data directory (parent of all agent subdirectories) */
export const DEFAULT_DATA_ROOT = join(homedir(), ".openclaw", "context-offload");

// Session registry + StorageContext builder
export {
  parseSessionKey,
  createStorageContext,
  ensureDirs,
  registerSession,
  lookupSessionId,
  listRegisteredSessions,
} from "./storage/session-registry.js";

// Sanitize layer
export {
  sanitizeText,
  sanitizeJsonLine,
  validateEntry,
  parseJsonlSafe,
  safeStringifyEntry,
  extractConfirmedIdsFromEntries,
  extractDeletedIdsFromEntries,
} from "./storage/sanitize.js";

// Current-session JSONL ops
export {
  appendOffloadEntries,
  readOffloadEntries,
  rewriteOffloadEntries,
  markOffloadStatus,
} from "./storage/jsonl-current.js";

// All-sessions JSONL ops
export {
  readAllOffloadEntries,
  rewriteAllOffloadEntries,
  updateOffloadNodeIds,
} from "./storage/jsonl-all.js";

// MMD (Mermaid) ops
export {
  writeMmd,
  patchMmd,
  readMmd,
  deleteMmd,
  listMmds,
  type MmdReplaceBlock,
} from "./storage/mmd-ops.js";

// Ref MD ops
export {
  isoToFilename,
  writeRefMd,
  readRefMd,
} from "./storage/ref-md.js";

// State file ops
export {
  readStateFile,
  writeStateFile,
} from "./storage/state-files.js";
