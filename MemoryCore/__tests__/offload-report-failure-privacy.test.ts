import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

const script = `
import { BackendClient } from "./src/offload/backend-client.ts";
import { reportL3Trigger } from "./src/offload/state-reporter.ts";
const mode=process.env.SYNTHETIC_REPORT_MODE;
const marker="synthetic-private-report-error";
const logs=[];const log=message=>logs.push(message);
const logger={info:log,debug:log,warn:log,error:log};let coerced=0;
const failure=mode==="private"?new Error(marker):{toString(){coerced++;throw new Error("synthetic-error-coercion");}};
const client=new BackendClient("http://127.0.0.1:1",logger);
const report={stage:"assemble"};
Object.defineProperty(report,"syntheticPayload",{enumerable:true,get(){throw failure;}});
if(mode==="schedule")Object.defineProperty(client,"storeState",{get(){throw failure;}});
reportL3Trigger(mode==="null"?null:client,report,logger);
await new Promise(resolve=>setTimeout(resolve,25));
console.log(JSON.stringify({logs,coerced}));
`;
describe("offload reporter failure handling preserves diagnostic privacy", () => {
  it.each(["private", "poison", "schedule"])("handles %s failure without payload logging or coercion", mode => {
    const result=spawnSync(process.execPath,["--unhandled-rejections=strict","--import","tsx","--input-type=module","-e",script],
      {cwd:process.cwd(),env:{...process.env,SYNTHETIC_REPORT_MODE:mode},encoding:"utf8",timeout:15000});
    expect(result.status,result.stderr).toBe(0);
    const data=JSON.parse(result.stdout.trim());
    expect(data.coerced).toBe(0);expect(data.logs.join("\n")).not.toContain("synthetic-private-report-error");
    expect(data.logs.some((line:string)=>line.includes("state-report"))).toBe(true);
  });
  it("keeps reporting disabled without a backend", () => {
    const result=spawnSync(process.execPath,["--unhandled-rejections=strict","--import","tsx","--input-type=module","-e",script],
      {cwd:process.cwd(),env:{...process.env,SYNTHETIC_REPORT_MODE:"null"},encoding:"utf8",timeout:15000});
    expect(result.status,result.stderr).toBe(0);expect(JSON.parse(result.stdout.trim())).toEqual({logs:[],coerced:0});
  });
});
