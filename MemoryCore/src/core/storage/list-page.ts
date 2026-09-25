/**
 * Shared listObjects pagination — D9.2 clauses 5 and 9.
 *
 * Every backend sorts, pages and reports `total` the same way, so the two
 * clauses cannot drift between implementations.
 */

import type { ListEntry, ListObjectsOptions, ListResult } from "./types.js";

/**
 * Sort `all` by key and cut the page addressed by `opts`.
 *
 * The marker is the last key of the previous page and is resumed *strictly
 * after*, which makes it opaque to callers (clause 9). `total` is the count of
 * entries on this page, never the total number of matches (clause 5).
 */
export function pageEntries(all: ListEntry[], opts?: ListObjectsOptions): ListResult {
  const maxKeys = opts?.maxKeys ?? 100;
  const sorted = all.slice().sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const marker = opts?.marker;
  const found = marker ? sorted.findIndex((e) => e.key > marker) : 0;
  const startIdx = found < 0 ? sorted.length : found;
  const page = sorted.slice(startIdx, startIdx + maxKeys);

  return {
    entries: page,
    nextMarker: startIdx + page.length < sorted.length ? page[page.length - 1]?.key : undefined,
    total: page.length,
  };
}
