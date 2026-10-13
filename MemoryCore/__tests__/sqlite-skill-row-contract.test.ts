import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SqliteSkillStore } from "../src/core/store/sqlite/skill-store.js";
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
async function fixture() {
 const db=new DatabaseSync(":memory:");databases.push(db); const store=new SqliteSkillStore({db,dimensions:0}); store.init();
 const input={skill_id:"synthetic",team_id:"team",owner_agent_id:"agent",name:"example",description:"",content:"ordinary",content_hash:"synthetic",manifest:[],storage_dir:"synthetic-unused"};
 await store.appendVersion(input); return {db,store,input};
}
it("rejects SQLite blob values in string identity columns without leaking the value", async()=> {
 const {db,store}=await fixture();db.prepare("UPDATE skills SET user_id=?").run(Buffer.from("synthetic-private-row-marker"));
 await expect(store.getHead("synthetic","team")).rejects.toThrow("Invalid SQLite skill row");
});
it("rejects unknown persisted skill status instead of asserting the union type", async()=> {
 const {db,store}=await fixture();db.prepare("UPDATE skills SET status=?").run("synthetic-private-status");
 await expect(store.getHeadIncludingArchived("synthetic","team")).rejects.toThrow("Invalid SQLite skill row");
});
it("rejects fractional persisted versions", async()=> {
 const {db,store}=await fixture();db.prepare("UPDATE skills SET version=?").run(1.5);
 await expect(store.listVersions("synthetic","team")).rejects.toThrow("Invalid SQLite skill row");
});
it("rejects a non-boolean persisted head flag", async()=> {
 const {db,store}=await fixture();db.prepare("UPDATE skills SET is_head=?").run(2);
 await expect(store.getByVersion("synthetic",1,"team")).rejects.toThrow("Invalid SQLite skill row");
});
it("retains malformed legacy manifest fallback without altering persistent data", async()=> {
 const {db,store}=await fixture();db.prepare("UPDATE skills SET manifest_json=?").run("{legacy-invalid");
 expect((await store.getHead("synthetic","team"))?.manifest).toEqual([]);
 expect(db.prepare("SELECT manifest_json FROM skills").get()?.manifest_json).toBe("{legacy-invalid");
});
it("retains version snapshots, scoped counts and numeric deletion counts", async()=> {
 const {store,input}=await fixture();await store.appendVersion({...input,content:"updated"});
 expect((await store.listVersions("synthetic","team")).map(s=>[s.version,s.is_head])).toEqual([[2,true],[1,false]]);
 expect(await store.countVersions("synthetic","team")).toBe(2);
 expect((await store.listSkills({team_id:"team"})).total).toBe(1);
 expect(await store.getHead("missing","team")).toBeNull();
 expect(await store.deleteAllVersions("synthetic","foreign")).toBe(0);
 expect(await store.deleteAllVersions("synthetic","team")).toBe(2);
});
