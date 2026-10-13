import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OffloadStateManager } from "../src/offload/state-manager.js";
import { injectMmdIntoMessages, maybeUpdateMmdInMessages, MMD_MESSAGE_MARKER } from "../src/offload/mmd-injector.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const config = { l3TokenCountMode: "heuristic" as const };
async function fixture() {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"mmd-injector-"));roots.push(root);
 const manager=new OffloadStateManager();await manager.init(root,"synthetic-agent","synthetic-session");
 manager.setMmdInjectionReady(true);manager.setActiveMmd("synthetic-private-task.mmd","synthetic-id");
 const logs:string[]=[];const log=(message:string)=>logs.push(message);
 const logger={debug:log,info:log,warn:log,error:log};const messages:any[]=[{role:"user",content:"synthetic request"}];
 return {manager,logs,logger,messages,file:path.join(manager.ctx.mmdsDir,manager.getActiveMmdFile()!)};
}
describe("MMD injection refresh and diagnostic boundaries",()=>{
 it.each([["aaaa","bbbb"],["任务甲","任务乙"]])("refreshes same-length tail change %s -> %s",async(oldTail,newTail)=>{
  const f=await fixture();const prefix="flowchart TD\n%% "+"x".repeat(96)+"\n";
  const before=prefix+`N1[${oldTail}]`,after=prefix+`N1[${newTail}]`;
  expect(before.length).toBe(after.length);expect(before.slice(0,64)).toBe(after.slice(0,64));
  await fs.writeFile(f.file,before);await injectMmdIntoMessages(f.messages,f.manager,f.logger,undefined,config);
  await fs.writeFile(f.file,after);
  expect(await maybeUpdateMmdInMessages(f.messages,f.manager,f.logger,undefined,config)).toBe(true);
  const injected=f.messages.filter(m=>m[MMD_MESSAGE_MARKER]);expect(injected).toHaveLength(1);
  expect(injected[0].content[0].text).toContain(after);expect(injected[0].content[0].text).not.toContain(oldTail);
  expect(await maybeUpdateMmdInMessages(f.messages,f.manager,f.logger,undefined,config)).toBe(false);
  expect(f.manager.getInjectedMmdVersion(f.manager.getActiveMmdFile()!)).toMatch(/^[0-9a-f]{64}$/);
 });
 it("keeps intended prompt context while omitting private filenames from diagnostics",async()=>{
  const f=await fixture();const text="flowchart TD\nN1[synthetic-private-body]";await fs.writeFile(f.file,text);
  const result=await injectMmdIntoMessages(f.messages,f.manager,f.logger,undefined,config);
  expect(result.mmdTokens).toBeGreaterThan(0);expect(f.messages.find(m=>m[MMD_MESSAGE_MARKER]).content[0].text).toContain(text);
  expect(f.logs.join("\n")).not.toContain("synthetic-private-task");expect(f.logs.join("\n")).not.toContain("synthetic-private-body");
 });
 it("bounds filesystem read errors in incremental diagnostics",async()=>{
  const f=await fixture();await fs.mkdir(f.file);
  expect(await maybeUpdateMmdInMessages(f.messages,f.manager,f.logger,undefined,config)).toBe(false);
  expect(f.logs.join("\n")).not.toContain("synthetic-private-task");expect(f.logs.join("\n")).not.toContain(f.file);
 });
 it.each(["incremental","full"])("does not coerce caught errors in %s injection",async mode=>{
  const f=await fixture();let coerced=0;
  Object.defineProperty(f.manager,"ctx",{get(){throw {toString(){coerced++;throw new Error("synthetic-coercion-failure");}};}});
  if(mode==="incremental")expect(await maybeUpdateMmdInMessages(f.messages,f.manager,f.logger,undefined,config)).toBe(false);
  else expect(await injectMmdIntoMessages(f.messages,f.manager,f.logger,undefined,config)).toEqual({mmdTokens:0});
  expect(coerced).toBe(0);
 });
 it("preserves existing injection while waiting for L1.5",async()=>{
  const f=await fixture();f.messages.push({role:"user",content:[{type:"text",text:"synthetic-prior-context"}],[MMD_MESSAGE_MARKER]:"active"});
  f.manager.lastMmdInjectedTokens=7;const before=JSON.stringify(f.messages);
  expect(await injectMmdIntoMessages(f.messages,f.manager,f.logger,undefined,config,{waitForL15:true})).toEqual({mmdTokens:7});
  expect(JSON.stringify(f.messages)).toBe(before);
 });
});
