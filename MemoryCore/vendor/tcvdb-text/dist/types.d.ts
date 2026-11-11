/**
 * Sparse vector representation: array of [hash_id, weight] pairs.
 * Compatible with Tencent Cloud VectorDB hybridSearch match.data format.
 */
export type SparseVector = Array<[number, number]>;
/** Hash function type: maps a string or number to a uint32 hash value. */
export type HashFunction = (text: string | number) => number;
//# sourceMappingURL=types.d.ts.map