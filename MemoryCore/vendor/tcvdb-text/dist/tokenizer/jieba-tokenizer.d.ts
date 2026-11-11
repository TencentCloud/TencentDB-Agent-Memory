import { BaseTokenizer, type TokenizerParams } from "./base-tokenizer.js";
export interface JiebaTokenizerOptions extends TokenizerParams {
    cutAll?: boolean;
    forSearch?: boolean;
    HMM?: boolean;
    usePaddle?: boolean;
}
export declare class JiebaTokenizer extends BaseTokenizer {
    cutAll: boolean;
    forSearch: boolean;
    HMM: boolean;
    usePaddle: boolean;
    constructor(opts?: Partial<JiebaTokenizerOptions>);
    updatedParameter(opts: Partial<JiebaTokenizerOptions>): void;
    getParameter(): Record<string, unknown>;
    tokenize(sentence: string): string[];
    encode(sentence: string): number[];
    decode(_tokens: number[]): string;
    cut(sentence: string): string[];
    cutForSearch(sentence: string): string[];
    setDict(dictFile: string): void;
}
//# sourceMappingURL=jieba-tokenizer.d.ts.map