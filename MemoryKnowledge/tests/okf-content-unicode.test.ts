import {it,expect} from "vitest";
import {validateBundle,BundleValidationError} from "../src/engines/wiki/okf-bundle-validation.js";
it.each(["\ud800","\udc00","x\ud800y"])("rejects lossy UTF16 payload %j",bad=>{for(const encoding of [undefined,"utf-8"] as const)expect(()=>validateBundle([{path:"data.txt",content:bad,encoding}])).toThrow(BundleValidationError)});
it.each(["ASCII","\ufffd","\ud83d\ude42"])("permits well-formed text %j",content=>{expect(validateBundle([{path:"data.txt",content}]).files).toBe(1)});
it("keeps arbitrary binary base64",()=>{expect(validateBundle([{path:"data.bin",content:"/w==",encoding:"base64"}]).files).toBe(1)});
it("rejects malformed Markdown body",()=>{expect(()=>validateBundle([{path:"fact.md",content:"---\ntype: concept\n---\n\ud800"}])).toThrow(BundleValidationError)});
