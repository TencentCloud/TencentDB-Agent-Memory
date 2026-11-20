import type { HashFunction } from "../types.js";
export interface TokenizerParams {
    hashFunction: HashFunction;
    stopWords?: boolean | string | string[] | Set<string> | Record<string, unknown>;
    lowerCase?: boolean;
    dictFile?: string | null;
    fileEncoding?: BufferEncoding;
}
export declare abstract class BaseTokenizer {
    hashFunction: HashFunction;
    stopWords: boolean | string | string[] | Set<string> | Record<string, unknown> | undefined;
    lowerCase: boolean;
    dictFile: string | null;
    fileEncoding: BufferEncoding;
    private _stopWords;
    constructor(opts: TokenizerParams);
    setStopwords(stopWords: boolean | string | string[] | Set<string> | Record<string, unknown>, fileEncoding?: BufferEncoding): void;
    updatedParameter(opts: TokenizerParams): void;
    getParameter(): Record<string, unknown>;
    abstract tokenize(sentence: string): string[];
    abstract encode(sentence: string): number[];
    abstract decode(tokens: number[]): string;
    protected isStopWord(word: string): boolean;
    setDict(_dictFile: string): void;
}
export declare class StopWords {
    private _set;
    constructor(vocab: boolean | string | string[] | Set<string> | Record<string, unknown> | undefined | null, fileEncoding?: BufferEncoding);
    check(word: string): boolean;
}
//# sourceMappingURL=base-tokenizer.d.ts.map