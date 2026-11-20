import { readFileSync } from "node:fs";
import loadJieba from "#jieba-loader";
import { createRequire } from "node:module";
const { Jieba } = loadJieba(createRequire(import.meta.url));
import { dict } from "@node-rs/jieba/dict.js";
import { Hash } from "../hash.js";
import { BaseTokenizer } from "./base-tokenizer.js";
// Module-level singleton — initialised once with the bundled default dictionary.
const jieba = Jieba.withDict(dict);
export class JiebaTokenizer extends BaseTokenizer {
    cutAll;
    forSearch;
    HMM;
    usePaddle;
    constructor(opts) {
        super({
            hashFunction: opts?.hashFunction ?? Hash.mmh3Hash,
            stopWords: opts?.stopWords ?? true,
            lowerCase: opts?.lowerCase ?? false,
            dictFile: opts?.dictFile ?? null,
            fileEncoding: opts?.fileEncoding,
        });
        this.cutAll = opts?.cutAll ?? false;
        this.forSearch = opts?.forSearch ?? false;
        this.HMM = opts?.HMM ?? true;
        this.usePaddle = opts?.usePaddle ?? false;
        if (this.dictFile != null) {
            this.setDict(this.dictFile);
        }
    }
    updatedParameter(opts) {
        super.updatedParameter({
            hashFunction: opts.hashFunction ?? Hash.mmh3Hash,
            stopWords: opts.stopWords,
            lowerCase: opts.lowerCase,
            dictFile: opts.dictFile,
            fileEncoding: opts.fileEncoding,
        });
        this.cutAll = opts.cutAll ?? false;
        this.forSearch = opts.forSearch ?? false;
        this.HMM = opts.HMM ?? true;
        this.usePaddle = opts.usePaddle ?? false;
        if (this.dictFile != null) {
            this.setDict(this.dictFile);
        }
    }
    getParameter() {
        const fnName = this.hashFunction.name;
        const hashName = fnName === "mmh3Hash" ? "mmh3_hash" : (fnName || "mmh3_hash");
        return {
            hash_function: hashName,
            stop_words: this.stopWords,
            lower_case: this.lowerCase,
            dict_file: this.dictFile,
            cut_all: this.cutAll,
            for_search: this.forSearch,
            HMM: this.HMM,
            use_paddle: this.usePaddle,
        };
    }
    tokenize(sentence) {
        if (typeof sentence !== "string") {
            throw new TypeError(`input sentence(${sentence}) must be a string`);
        }
        if (sentence.length === 0) {
            return [];
        }
        let text = sentence;
        if (this.lowerCase) {
            text = text.toLowerCase();
        }
        let segs;
        if (this.forSearch) {
            segs = this.cutForSearch(text);
        }
        else {
            segs = this.cut(text);
        }
        const words = [];
        for (const word of segs) {
            if (word === " " || word === "") {
                continue;
            }
            if (this.isStopWord(word)) {
                continue;
            }
            words.push(word);
        }
        return words;
    }
    encode(sentence) {
        const tokens = [];
        for (const word of this.tokenize(sentence)) {
            tokens.push(this.hashFunction(word));
        }
        return tokens;
    }
    decode(_tokens) {
        throw new Error("decode method is not implemented");
    }
    cut(sentence) {
        if (this.cutAll) {
            return jieba.cutAll(sentence);
        }
        return jieba.cut(sentence, this.HMM);
    }
    cutForSearch(sentence) {
        return jieba.cutForSearch(sentence, this.HMM);
    }
    setDict(dictFile) {
        this.dictFile = dictFile;
        const content = readFileSync(dictFile);
        jieba.loadDict(content);
    }
}
