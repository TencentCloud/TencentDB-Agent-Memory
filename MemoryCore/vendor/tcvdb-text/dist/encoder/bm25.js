import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Hash, hashFunctionFromName } from "../hash.js";
import { dataDir } from "../paths.js";
import { JiebaTokenizer } from "../tokenizer/jieba-tokenizer.js";
import { BaseSparseEncoder } from "./base-encoder.js";
/**
 * BM25 implementation of sparse encoder.
 * Corresponds to Python tcvdb_text.encoder.bm25.BM25Encoder.
 */
export class BM25Encoder extends BaseSparseEncoder {
    b;
    k1;
    tokenizer;
    // Learned params
    tokenFreq = null;
    docCount = null;
    averageDocLength = null;
    totalDocLength = 0;
    constructor(opts) {
        super();
        this.b = opts?.b ?? 0.75;
        this.k1 = opts?.k1 ?? 1.2;
        this.tokenizer = opts?.tokenizer ?? new JiebaTokenizer({ hashFunction: Hash.mmh3Hash });
    }
    /**
     * Get a BM25Encoder with default OKAPI BM25 model parameters.
     */
    static default(name = "zh") {
        let path;
        if (name === "zh") {
            path = resolve(dataDir, "bm25_zh_default.json");
        }
        else if (name === "en") {
            path = resolve(dataDir, "bm25_en_default.json");
        }
        else {
            throw new Error("input name must be 'zh' or 'en'");
        }
        const encoder = new BM25Encoder();
        encoder.setParamsSync(path);
        return encoder;
    }
    _tf(text) {
        const rawTokens = this.tokenizer.encode(text);
        const counter = new Map();
        for (const t of rawTokens) {
            counter.set(t, (counter.get(t) ?? 0) + 1);
        }
        const tokens = [];
        const counts = [];
        for (const [t, c] of counter) {
            tokens.push(t);
            counts.push(c);
        }
        return { tokens, counts };
    }
    _encodeSingleDocument(text) {
        const { tokens, counts } = this._tf(text);
        const tfSum = counts.reduce((a, b) => a + b, 0);
        const vectors = [];
        for (let i = 0; i < tokens.length; i++) {
            const tf = counts[i];
            const tfNormed = tf / (this.k1 * (1.0 - this.b + this.b * (tfSum / this.averageDocLength)) + tf);
            vectors.push([tokens[i], tfNormed]);
        }
        return vectors;
    }
    encodeTexts(texts) {
        if (this.tokenFreq === null ||
            this.docCount === null ||
            this.averageDocLength === null) {
            throw new Error("BM25 must be fit before encoding documents");
        }
        if (typeof texts === "string") {
            return this._encodeSingleDocument(texts);
        }
        if (Array.isArray(texts)) {
            return texts.map((t) => this._encodeSingleDocument(t));
        }
        throw new Error("texts must be a string or array of strings");
    }
    _encodeSingleQuery(text) {
        const { tokens } = this._tf(text);
        const idfs = [];
        for (const idx of tokens) {
            const df = this.tokenFreq[String(idx)] ?? 1;
            idfs.push(Math.log((this.docCount + 1) / (df + 0.5)));
        }
        const idfSum = idfs.reduce((a, b) => a + b, 0);
        const vectors = [];
        for (let i = 0; i < tokens.length; i++) {
            const idfNorm = idfSum === 0 ? 0 : idfs[i] / idfSum;
            vectors.push([tokens[i], idfNorm]);
        }
        return vectors;
    }
    encodeQueries(texts) {
        if (this.tokenFreq === null ||
            this.docCount === null ||
            this.averageDocLength === null) {
            throw new Error("BM25 must be fit before encoding queries");
        }
        if (typeof texts === "string") {
            return this._encodeSingleQuery(texts);
        }
        if (Array.isArray(texts)) {
            return texts.map((t) => this._encodeSingleQuery(t));
        }
        throw new Error("texts must be a string or array of strings");
    }
    fitCorpus(corpus) {
        const docs = typeof corpus === "string" ? [corpus] : corpus;
        let docNum = 0;
        let sumDocLen = 0;
        const tokenFreqCounter = new Map();
        for (const doc of docs) {
            if (typeof doc !== "string") {
                throw new Error("corpus must be a list of strings");
            }
            const { tokens, counts } = this._tf(doc);
            if (tokens.length === 0) {
                continue;
            }
            docNum += 1;
            sumDocLen += counts.reduce((a, b) => a + b, 0);
            // Count unique tokens per document (document frequency)
            const uniqueTokens = new Set(tokens.map(String));
            for (const t of uniqueTokens) {
                tokenFreqCounter.set(t, (tokenFreqCounter.get(t) ?? 0) + 1);
            }
        }
        if (this.tokenFreq === null ||
            this.docCount === null ||
            this.averageDocLength === null) {
            this.tokenFreq = Object.fromEntries(tokenFreqCounter);
            this.docCount = docNum;
            this.averageDocLength = docNum > 0 ? sumDocLen / docNum : 0;
            this.totalDocLength = sumDocLen;
        }
        else {
            if (this.totalDocLength === 0) {
                this.totalDocLength = this.averageDocLength * this.docCount;
            }
            this.totalDocLength += sumDocLen;
            this.docCount += docNum;
            this.averageDocLength = this.docCount > 0 ? this.totalDocLength / this.docCount : 0;
            for (const [k, v] of tokenFreqCounter) {
                const count = this.tokenFreq[k] ?? 0;
                this.tokenFreq[k] = count + v;
            }
        }
    }
    async downloadParams(paramsFile) {
        this.downloadParamsSync(paramsFile);
    }
    downloadParamsSync(paramsFile) {
        if (typeof paramsFile !== "string") {
            throw new TypeError("input path must be a string");
        }
        if (!paramsFile) {
            throw new Error("input path should not be empty");
        }
        if (this.tokenFreq === null ||
            this.docCount === null ||
            this.averageDocLength === null) {
            throw new Error("BM25 must be fit before storing params");
        }
        const tokenizerParam = this.tokenizer.getParameter();
        // Sort token_freq by key
        const sortedEntries = Object.entries(this.tokenFreq).sort(([a], [b]) => a.localeCompare(b));
        this.tokenFreq = Object.fromEntries(sortedEntries);
        const data = {
            b: this.b,
            k1: this.k1,
            token_freq: this.tokenFreq,
            doc_count: this.docCount,
            average_doc_length: this.averageDocLength,
            ...tokenizerParam,
        };
        const dir = dirname(paramsFile);
        if (dir && dir !== ".") {
            mkdirSync(dir, { recursive: true });
        }
        writeFileSync(paramsFile, JSON.stringify(data, null, 2), "utf-8");
    }
    async setParams(paramsFile, _fileEncoding) {
        return this.setParamsSync(paramsFile, _fileEncoding);
    }
    setParamsSync(paramsFile, _fileEncoding) {
        if (typeof paramsFile !== "string") {
            throw new TypeError("input path must be a string");
        }
        if (paramsFile.length === 0) {
            throw new Error("input path should not be empty");
        }
        if (!existsSync(paramsFile)) {
            throw new Error(`file not found: ${paramsFile}`);
        }
        const raw = readFileSync(paramsFile, "utf-8");
        const data = JSON.parse(raw);
        this.b = data.b;
        this.k1 = data.k1;
        this.tokenFreq = data.token_freq;
        this.docCount = data.doc_count;
        this.averageDocLength = data.average_doc_length;
        const hashFunction = hashFunctionFromName(data.hash_function ?? "mmh3_hash");
        this.tokenizer.updatedParameter({
            hashFunction,
            stopWords: data.stop_words ?? true,
            lowerCase: data.lower_case ?? false,
            dictFile: data.dict_file ?? undefined,
        });
        return this;
    }
    setDict(dictFile) {
        this.tokenizer.setDict(dictFile);
    }
}
//# sourceMappingURL=bm25.js.map