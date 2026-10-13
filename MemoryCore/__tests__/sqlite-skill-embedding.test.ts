import { afterEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { SqliteSkillStore } from "../src/core/store/sqlite/skill-store.js";
import { VectorStore } from "../src/core/store/sqlite/memory-store.js";
const dbs: DatabaseSync[]=[]; afterEach(()=>{for(const db of dbs.splice(0))db.close();});
function db(){const d=new DatabaseSync(":memory:",{allowExtension:true});dbs.push(d);return d;}
function nativeStore(){const d=db();createRequire(import.meta.url)("sqlite-vec").load(d);const s=new SqliteSkillStore({db:d,dimensions:2});s.init();expect(s.getCapabilities().vectorSearch).toBe(true);return {d,s};}
it("writes only the supplied Float32Array view through actual sqlite-vec",()=>{
 const {d,s}=nativeStore();const backing=new Float32Array([12345,1,2,54321]);s.upsertEmbedding("view",backing.subarray(1,3));
 const row=d.prepare("SELECT embedding FROM skill_vec WHERE skill_id=?").get("view");expect(row?.embedding).toEqual(new Uint8Array(new Float32Array([1,2]).buffer));
});
it("retains ordinary full-array writes through actual sqlite-vec",()=>{
 const {d,s}=nativeStore();s.upsertEmbedding("ordinary",new Float32Array([3,4]));expect(d.prepare("SELECT embedding FROM skill_vec WHERE skill_id=?").get("ordinary")?.embedding).toEqual(new Uint8Array(new Float32Array([3,4]).buffer));
});
function fixture(){
 const d=db();d.exec("CREATE TABLE skill_vec(skill_id TEXT PRIMARY KEY, embedding BLOB)");d.prepare("INSERT INTO skill_vec VALUES (?,?)").run("existing",Buffer.from(new Float32Array([1,2]).buffer));
 const logger={info:vi.fn(),warn:vi.fn(),error:vi.fn()};
 const receiver={db:d,dimensions:2,vecAvailable:true,logger};
 function method(name:string){const fn:unknown=Object.getOwnPropertyDescriptor(SqliteSkillStore.prototype,name)?.value;if(typeof fn!=="function")throw new Error("Missing embedding method");return fn;}
 const fail=()=>d.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON skill_vec BEGIN SELECT RAISE(ABORT, 'synthetic-private-backend-error'); END");
 return {d,logger,fail,write:(v:Float32Array)=>method("upsertEmbedding").call(receiver,"existing",v),remove:()=>method("deleteEmbedding").call(receiver,"existing")};
}
it("preserves the prior embedding when replacement insertion fails",()=>{
 const {d,fail,write}=fixture();fail();write(new Float32Array([3,4]));expect(d.prepare("SELECT embedding FROM skill_vec WHERE skill_id='existing'").get()?.embedding).toEqual(new Uint8Array(new Float32Array([1,2]).buffer));
});
it("contains failed replacement without rolling back the caller transaction",()=>{
 const {d,fail,write}=fixture();fail();d.exec("CREATE TABLE marker(value TEXT); BEGIN; INSERT INTO marker VALUES ('caller')");write(new Float32Array([3,4]));
 expect(d.prepare("SELECT value FROM marker").get()?.value).toBe("caller");expect(d.prepare("SELECT embedding FROM skill_vec WHERE skill_id='existing'").get()).toBeDefined();d.exec("ROLLBACK");expect(d.prepare("SELECT value FROM marker").get()).toBeUndefined();
});
it("omits raw SQLite insertion errors from embedding diagnostics",()=>{
 const {logger,fail,write}=fixture();fail();write(new Float32Array([3,4]));expect(logger.warn).toHaveBeenCalled();expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("synthetic-private-backend-error");
});
it("omits raw SQLite deletion errors while retaining the row",()=>{
 const {d,logger,remove}=fixture();d.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON skill_vec BEGIN SELECT RAISE(ABORT, 'synthetic-private-backend-error'); END");remove();
 expect(d.prepare("SELECT embedding FROM skill_vec WHERE skill_id='existing'").get()).toBeDefined();expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("synthetic-private-backend-error");
});

function memoryFixture(){
 const d=db();d.exec("CREATE TABLE l0_vec(record_id TEXT PRIMARY KEY, embedding BLOB, recorded_at TEXT); CREATE TABLE l1_vec(record_id TEXT PRIMARY KEY, embedding BLOB, updated_time TEXT); CREATE TABLE l0_meta(record_id TEXT PRIMARY KEY, recorded_at TEXT); INSERT INTO l0_meta VALUES ('l0','synthetic-time')");
 const receiver={db:d,degraded:false,vecTablesReady:true,logger:{info:vi.fn(),warn:vi.fn(),debug:vi.fn()},
 stmtL0GetMeta:d.prepare("SELECT recorded_at FROM l0_meta WHERE record_id=?"),stmtL0DeleteVec:d.prepare("DELETE FROM l0_vec WHERE record_id=?"),stmtL0InsertVec:d.prepare("INSERT INTO l0_vec VALUES (?,?,?)"),
 stmtDeleteVec:d.prepare("DELETE FROM l1_vec WHERE record_id=?"),stmtInsertVec:d.prepare("INSERT INTO l1_vec VALUES (?,?,?)"),
 getAllL0Texts:()=>[{record_id:"l0",message_text:"synthetic",recorded_at:"synthetic-time"}],getAllL1Texts:()=>[{record_id:"l1",content:"synthetic",updated_time:"synthetic-time"}]};
 function method(name:string){const fn:unknown=Object.getOwnPropertyDescriptor(VectorStore.prototype,name)?.value;if(typeof fn!=="function")throw new Error("Missing memory vector method");return fn;}
 return {d,receiver,method};
}
it("writes only the view in the actual deferred L0 embedding method",()=>{
 const {d,receiver,method}=memoryFixture();const view=new Float32Array([12345,1,2,54321]).subarray(1,3);
 expect(method("updateL0Embedding").call(receiver,"l0",view)).toBe(true);expect(d.prepare("SELECT embedding FROM l0_vec").get()?.embedding).toEqual(new Uint8Array(new Float32Array([1,2]).buffer));
});
it("writes only callback views in actual L0 and L1 reindex methods",async()=>{
 const {d,receiver,method}=memoryFixture();const view=new Float32Array([12345,1,2,54321]).subarray(1,3);
 expect(await method("reindexAll").call(receiver,async()=>view)).toEqual({l1Count:1,l0Count:1});
 for(const table of ["l0_vec","l1_vec"])expect(d.prepare(`SELECT embedding FROM ${table}`).get()?.embedding).toEqual(new Uint8Array(new Float32Array([1,2]).buffer));
});
