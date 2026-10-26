import type { HashFunction } from "./types.js";
export declare class Hash {
    /**
     * Use MurmurHash3 to hash text to 32-bit unsigned integer.
     * Compatible with Python mmh3.hash(text, signed=False).
     */
    static mmh3Hash(text: string | number): number;
}
export declare function hashFunctionFromName(name: string): HashFunction;
//# sourceMappingURL=hash.d.ts.map