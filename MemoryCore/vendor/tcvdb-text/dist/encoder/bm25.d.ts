import type { BaseTokenizer } from "../tokenizer/base-tokenizer.js";
import type { SparseVector } from "../types.js";
import { BaseSparseEncoder } from "./base-encoder.js";
/**
 * BM25 implementation of sparse encoder.
 * Corresponds to Python tcvdb_text.encoder.bm25.BM25Encoder.
 */
export declare class BM25Encoder extends BaseSparseEncoder {
    b: number;
    k1: number;
    tokenizer: BaseTokenizer;
    tokenFreq: Record<string, number> | null;
    docCount: number | null;
    averageDocLength: number | null;
    totalDocLength: number;
    constructor(opts?: {
        b?: number;
        k1?: number;
        tokenizer?: BaseTokenizer;
    });
    /**
     * Get a BM25Encoder with default OKAPI BM25 model parameters.
     */
    static default(name?: "zh" | "en"): BM25Encoder;
    private _tf;
    private _encodeSingleDocument;
    encodeTexts(texts: string): SparseVector;
    encodeTexts(texts: string[]): SparseVector[];
    private _encodeSingleQuery;
    encodeQueries(texts: string): SparseVector;
    encodeQueries(texts: string[]): SparseVector[];
    fitCorpus(corpus: string | string[]): void;
    downloadParams(paramsFile: string): Promise<void>;
    downloadParamsSync(paramsFile: string): void;
    setParams(paramsFile: string, _fileEncoding?: BufferEncoding): Promise<this>;
    setParamsSync(paramsFile: string, _fileEncoding?: BufferEncoding): this;
    setDict(dictFile: string): void;
}
//# sourceMappingURL=bm25.d.ts.map