import { it, expect } from "vitest";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateBundle, importBundle, BundleValidationError } from "../src/engines/wiki/okf-bundle-import.js";
it.each(["\ud800.bin", "\udfff.bin", "dir/\ud801.bin", "x\ud800y.bin"])("rejects non-Unicode path before filesystem mutation %j", path => {
 expect(() => validateBundle([{path,content:"first"}])).toThrow(BundleValidationError);
});
it("refuses lossy filename aliases without replacing an existing replacement-character file", () => {
 const root=fs.mkdtempSync(join(tmpdir(),"okf-unicode-"));const wiki=join(root,"wiki");fs.mkdirSync(wiki);fs.writeFileSync(join(wiki,"\ufffd.bin"),"original");
 try {
  expect(() => importBundle(wiki,[{path:"\ud800.bin",content:"first"},{path:"\ud801.bin",content:"second"}])).toThrow(BundleValidationError);
  expect(fs.readdirSync(wiki)).toEqual(["\ufffd.bin"]);expect(fs.readFileSync(join(wiki,"\ufffd.bin"),"utf8")).toBe("original");
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
it("preserves valid astral filenames and the replacement character as distinct UTF-8 paths", () => {
 const root=fs.mkdtempSync(join(tmpdir(),"okf-unicode-valid-"));const wiki=join(root,"wiki");
 try {
  const files=[{path:"\ud83d\ude00.bin",content:"astral"},{path:"\ufffd.bin",content:"replacement"}];
  expect(importBundle(wiki,files).files).toBe(2);
  for(const f of files)expect(fs.readFileSync(join(wiki,f.path),"utf8")).toBe(f.content);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
