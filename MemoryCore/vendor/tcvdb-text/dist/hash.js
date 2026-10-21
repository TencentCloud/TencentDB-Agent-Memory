import murmurhash from "murmurhash";
export class Hash {
    /**
     * Use MurmurHash3 to hash text to 32-bit unsigned integer.
     * Compatible with Python mmh3.hash(text, signed=False).
     */
    static mmh3Hash(text) {
        if (typeof text === "number") {
            return text;
        }
        if (typeof text !== "string") {
            throw new TypeError(`input text(${text}) must be a string or number`);
        }
        return murmurhash.v3(text) >>> 0;
    }
}
export function hashFunctionFromName(name) {
    if (name === "mmh3_hash" || name === "mmh3Hash") {
        return Hash.mmh3Hash;
    }
    throw new Error(`no such hash function: ${name}`);
}
//# sourceMappingURL=hash.js.map