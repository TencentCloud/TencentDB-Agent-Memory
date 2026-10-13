import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

// Use Node's real loader: the module contains a conditional, legacy SDK import
// that is intentionally unavailable in modern hosts. No SDK modules are replaced.
function registration(kind: string) {
  const script = `
    import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    const {parseConfig}=await import(pathToFileURL(path.resolve('src/config.ts')));
    const {registerOffload}=await import(pathToFileURL(path.resolve('src/offload/index.ts')));
    const kind=${JSON.stringify(kind)};
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'offload-registration-'));
    const logs=[]; const hooks=new Map(); let conversions=0;
    const log=(message)=>logs.push(message);
    const config=parseConfig({offload:{enabled:true,mode:'collect',dataDir:dir,
      backendUrl:kind==='url'?'http://fixture:synthetic-private-url-password@127.0.0.1:1':'http://127.0.0.1:1',
      userId:kind==='identity'?'synthetic-private-user-identity':'fixture-user',offloadRetentionDays:0}}).offload;
    const api={config:{},logger:{debug:log,info:log,warn:log,error:log},on:(name,handler)=>hooks.set(name,handler)};
    if(kind==='source')api.on=function registerFixture(name,handler){const opaque='synthetic-private-hook-source';void opaque;hooks.set(name,handler)};
    if(kind==='conversion')Object.defineProperty(api.on,'toString',{value:()=>{conversions++;throw new Error('synthetic-conversion-error')}});
    let failure=null;try{registerOffload(api,config)}catch(error){failure=error.message}
    fs.rmSync(dir,{recursive:true,force:true});
    console.log(JSON.stringify({logs,conversions,failure,hookRegistered:hooks.has('after_tool_call')}));
    // Do not run scheduled collectors/reclaimers or invoke hooks in this fixture.
    process.exit(0);
  `;
  return JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-"], {
    input: script, encoding: "utf8", timeout: 15_000,
  })) as { logs: string[]; conversions: number; failure: string | null; hookRegistered: boolean };
}
describe("offload registration diagnostic privacy", () => {
  it("does not print a real hook registrar implementation", () => {
    const result = registration("source"); expect(result.failure).toBeNull();
    expect(result.hookRegistered).toBe(true);
    expect(result.logs.join("\n")).not.toContain("synthetic-private-hook-source");
  }, 20_000);
  it("does not invoke custom toString during diagnostics", () => {
    const result = registration("conversion");
    expect(result.failure).toBeNull(); expect(result.conversions).toBe(0);
    expect(result.hookRegistered).toBe(true);
  }, 20_000);
  it("does not print configured user identities", () => {
    const result = registration("identity"); expect(result.failure).toBeNull();
    expect(result.hookRegistered).toBe(true);
    expect(result.logs.join("\n")).not.toContain("synthetic-private-user-identity");
  }, 20_000);
  it("does not print credentials in a backend URL", () => {
    const result = registration("url"); expect(result.failure).toBeNull();
    expect(result.hookRegistered).toBe(true);
    expect(result.logs.join("\n")).not.toContain("synthetic-private-url-password");
    expect(result.logs.join("\n")).toContain("LLM mode: backend");
  }, 20_000);
});
