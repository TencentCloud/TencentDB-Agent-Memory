import CRC32 from "crc-32";
import { extractQueryTokens, segmentWords, ZH_STOP_WORDS } from "../tokenize.js";
import { ftsQueryToSearchText } from "../mongodb/doc-mappers.js";

export interface QdrantSparseVector {
  indices: number[];
  values: number[];
}

const K1 = 1.2;
const B = 0.75;
const AVG_DOC_LEN = 64;
const FTS5_OR_QUERY = /^\s*"[^"]+"(?:\s+OR\s+"[^"]+")*\s*$/;

function terms(tokens: string[]): number[] {
  return tokens
    .map((t) => t.trim().toLowerCase())
    .filter((t) => /[\p{L}\p{N}]/u.test(t) && !ZH_STOP_WORDS.has(t))
    .map((t) => CRC32.str(t) >>> 0);
}

export function encodeDocument(text: string): QdrantSparseVector {
  const ids = terms(segmentWords(text));
  const tf = new Map<number, number>();
  for (const id of ids) tf.set(id, (tf.get(id) ?? 0) + 1);
  const lengthNorm = K1 * (1 - B + (B * ids.length) / AVG_DOC_LEN);
  return {
    indices: [...tf.keys()],
    values: [...tf.values()].map((f) => (f * (K1 + 1)) / (f + lengthNorm)),
  };
}

export function encodeQuery(text: string): QdrantSparseVector {
  return queryVector(extractQueryTokens(text));
}

export function encodeFtsQuery(query: string): QdrantSparseVector {
  return FTS5_OR_QUERY.test(query) ? queryVector(ftsQueryToSearchText(query).split(/\s+/)) : encodeQuery(query);
}

function queryVector(tokens: string[]): QdrantSparseVector {
  const indices = [...new Set(terms(tokens))];
  return { indices, values: indices.map(() => 1) };
}
