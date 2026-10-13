import {afterEach,expect,it,vi} from "vitest";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";import {join} from "node:path";
import {StorageAdapter,createScopedStorageAdapter} from "../src/core/storage/adapter.js";
import {LocalStorageBackend} from "../src/core/storage/local-backend.js";
import type {IStorageBackend,ListResult,StorageObject} from "../src/core/storage/types.js";
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function real(){const root=await mkdtemp(join(tmpdir(),"scoped-synthetic-"));dirs.push(root);await mkdir(join(root,"profiles"));await writeFile(join(root,"foreign"),"synthetic-private-marker");return new StorageAdapter(new LocalStorageBackend(root));}
for(const prefix of ["/","profiles/../",".","profiles\\..\\team","\0"])it("rejects an invalid scope before backend access",async()=>{const base=await real();expect(()=>createScopedStorageAdapter(base,prefix)).toThrow("Invalid storage scope");});
function fake(){
 const object:StorageObject={key:"other/secret",content:Buffer.from("synthetic-private-marker"),size:24,lastModified:new Date(0)};
 const listing:ListResult={entries:[],total:0};
 const backend:IStorageBackend={type:"local",getObject:vi.fn(async()=>object),listObjects:vi.fn(async()=>listing),putObject:vi.fn(async()=>{}),appendObject:vi.fn(async()=>{}),exists:vi.fn(async()=>true),deleteObject:vi.fn(async()=>{}),deleteByPrefix:vi.fn(async()=>0)};
 return {object,listing,scoped:createScopedStorageAdapter(new StorageAdapter(backend),"scope")};
}
it("rejects a backend object from another scope",async()=>{const {scoped}=fake();await expect(scoped.readFile("file")).rejects.toThrow("out-of-scope");});
it("rejects foreign entries returned by a scoped listing",async()=>{const {scoped,listing}=fake();listing.entries.push({key:"other/secret",size:1,lastModified:new Date(0),isDirectory:false});await expect(scoped.readdirPage("")).rejects.toThrow("out-of-scope");});
it("rejects a foreign pagination marker",async()=>{const {scoped,listing}=fake();listing.nextMarker="other/secret";await expect(scoped.readdirPage("")).rejects.toThrow("out-of-scope");});
it("rejects a noncanonical backend key even when its text starts with the scope",async()=>{const {scoped,object}=fake();object.key="scope/../other/secret";await expect(scoped.readFile("file")).rejects.toThrow("out-of-scope");});
it("omits invalid requested key values from diagnostics",async()=>{const {scoped}=fake();try{await scoped.readFile("../synthetic-private-key");throw new Error("Expected rejection");}catch(e){expect(String(e)).not.toContain("synthetic-private-key");expect(String(e)).toContain("Path traversal rejected");}});
it("retains explicitly empty unscoped adapter identity",async()=>{const base=await real();expect(createScopedStorageAdapter(base,"")).toBe(base);});
it("retains ordinary scoped writes, reads, append and listing keys",async()=>{const base=await real();const scoped=createScopedStorageAdapter(base,"profiles//team/");await scoped.writeFile("nested/file","a");await scoped.appendFile("nested/file","b");expect(await scoped.readFile("nested/file")).toBe("ab");expect(await base.readFile("profiles/team/nested/file")).toBe("ab");expect((await scoped.readdirPage("nested/",{recursive:true})).entries.map(e=>e.key)).toEqual(["nested/file"]);expect(await scoped.readFile("foreign")).toBeNull();await scoped.rmdir("nested/");expect(await scoped.readFile("nested/file")).toBeNull();});
