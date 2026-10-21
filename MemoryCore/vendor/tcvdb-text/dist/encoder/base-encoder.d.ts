import type { SparseVector } from "../types.js";
/**
 * Abstract base class for sparse encoders.
 * Corresponds to Python tcvdb_text.encoder.base_encoder.BaseSparseEncoder.
 */
export declare abstract class BaseSparseEncoder {
    abstract encodeTexts(texts: string | string[]): SparseVector | SparseVector[];
    abstract encodeQueries(texts: string | string[]): SparseVector | SparseVector[];
    abstract fitCorpus(texts: string | string[]): void;
    abstract downloadParams(paramsFile: string): Promise<void>;
    abstract setParams(paramsFile: string, fileEncoding?: BufferEncoding): Promise<this>;
    abstract setDict(dictFile: string): void;
}
//# sourceMappingURL=base-encoder.d.ts.map