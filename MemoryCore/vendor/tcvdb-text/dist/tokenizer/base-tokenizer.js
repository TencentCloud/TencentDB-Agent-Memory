import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dataDir } from "../paths.js";
export class BaseTokenizer {
    hashFunction;
    stopWords;
    lowerCase;
    dictFile;
    fileEncoding;
    _stopWords;
    constructor(opts) {
        this.hashFunction = opts.hashFunction;
        this.stopWords = opts.stopWords;
        this.lowerCase = opts.lowerCase ?? false;
        this.dictFile = opts.dictFile ?? null;
        this.fileEncoding = opts.fileEncoding ?? "utf-8";
        this._stopWords =
            opts.stopWords == null ? null : new StopWords(opts.stopWords, this.fileEncoding);
    }
    setStopwords(stopWords, fileEncoding) {
        this.stopWords = stopWords;
        if (fileEncoding) {
            this.fileEncoding = fileEncoding;
        }
        this._stopWords = new StopWords(stopWords, this.fileEncoding);
    }
    updatedParameter(opts) {
        this.hashFunction = opts.hashFunction;
        this.stopWords = opts.stopWords;
        this.lowerCase = opts.lowerCase ?? false;
        this.dictFile = opts.dictFile ?? null;
        if (opts.fileEncoding) {
            this.fileEncoding = opts.fileEncoding;
        }
        this._stopWords =
            opts.stopWords == null ? null : new StopWords(opts.stopWords, this.fileEncoding);
    }
    getParameter() {
        const fnName = this.hashFunction.name;
        const hashName = fnName === "mmh3Hash" ? "mmh3_hash" : (fnName || "mmh3_hash");
        return {
            hash_function: hashName,
            stop_words: this.stopWords,
            lower_case: this.lowerCase,
            dict_file: this.dictFile,
        };
    }
    isStopWord(word) {
        if (this._stopWords === null) {
            return false;
        }
        return this._stopWords.check(word);
    }
    setDict(_dictFile) {
        // Override in subclass
    }
}
export class StopWords {
    _set;
    constructor(vocab, fileEncoding = "utf-8") {
        this._set = new Set();
        if (typeof vocab === "boolean" && vocab === true) {
            const defaultPath = resolve(dataDir, "stopwords.txt");
            const content = readFileSync(defaultPath, "utf-8");
            for (const line of content.split("\n")) {
                const trimmed = line.replace(/\r$/, "");
                if (trimmed.length > 0) {
                    this._set.add(trimmed);
                }
            }
        }
        else if (typeof vocab === "string") {
            const content = readFileSync(vocab, fileEncoding);
            for (const line of content.split("\n")) {
                const trimmed = line.replace(/\r$/, "");
                if (trimmed.length > 0) {
                    this._set.add(trimmed);
                }
            }
        }
        else if (Array.isArray(vocab)) {
            this._set = new Set(vocab);
        }
        else if (vocab instanceof Set) {
            this._set = vocab;
        }
        else if (vocab != null && typeof vocab === "object") {
            this._set = new Set(Object.keys(vocab));
        }
        else {
            this._set = null;
        }
    }
    check(word) {
        if (this._set === null) {
            return false;
        }
        return this._set.has(word);
    }
}
//# sourceMappingURL=base-tokenizer.js.map