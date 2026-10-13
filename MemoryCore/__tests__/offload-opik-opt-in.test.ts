import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

function probe(kind: string) {
  const script = `
    import http from 'node:http';import path from 'node:path';import {pathToFileURL}from'node:url';
    let requests=0,markerBodies=0,conversions=0;const logs=[];const marker='synthetic-offload-trace';
    const server=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{requests++;if(body.includes(marker))markerBodies++;res.writeHead(200,{'Content-Type':'application/json'});res.end('{}')})});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    process.env.OPIK_API_KEY='fixture-token';process.env.OPIK_URL_OVERRIDE='http://127.0.0.1:'+server.address().port+'/api';
    process.env.OPIK_PROJECT_NAME='fixture-project';process.env.OPIK_WORKSPACE='fixture-workspace';
    const kind=${JSON.stringify(kind)};let config={};
    const entries={entryOnly:{config:{}},disabled:{enabled:false},nestedDisabled:{enabled:true,config:{enabled:false}},enabled:{enabled:true},nestedEnabled:{config:{enabled:true}}};
    if(entries[kind])config={plugins:{entries:{'opik-openclaw':entries[kind]}}};
    if(kind==='error')Object.defineProperty(config,'plugins',{get(){throw {toString(){conversions++;return 'synthetic-private-init-error'}}}});
    const tracer=await import(pathToFileURL(path.resolve('src/offload/opik-tracer.ts')));
    const log=m=>logs.push(m);const logger={info:log,warn:log,error:log,debug:log};
    tracer.initOffloadOpikTracer(config,logger);let disabledDuringTransition=null;
    if(kind==='revoke'||kind==='reenable'){
      tracer.initOffloadOpikTracer({plugins:{entries:{'opik-openclaw':{enabled:true}}}},logger);
      tracer.initOffloadOpikTracer({plugins:{entries:{'opik-openclaw':{enabled:false}}}},logger);
      disabledDuringTransition=!tracer.isOffloadTracerEnabled();
      if(kind==='reenable')tracer.initOffloadOpikTracer({plugins:{entries:{'opik-openclaw':{enabled:true}}}},logger);
    }
    const enabled=tracer.isOffloadTracerEnabled();
    tracer.traceOffloadDecision({stage:'L3_after_tool_call',input:{fixture:marker},output:{fixture:true},logger});
    let timeout;await Promise.race([tracer.flushOffloadOpikTracer(),new Promise(r=>{timeout=setTimeout(r,2000)})]);clearTimeout(timeout);
    console.log('@@fixture-result@@'+JSON.stringify({enabled,requests,markerBodies,logs,conversions,disabledDuringTransition}));
    server.closeAllConnections();server.close();process.exit(0);
  `;
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-"], { input: script, encoding: "utf8", timeout: 15_000 });
  const line = output.split("\n").find(line => line.startsWith("@@fixture-result@@"));
  if (!line) throw new Error("fixture did not return results");
  return JSON.parse(line.slice("@@fixture-result@@".length)) as { enabled: boolean; requests: number; markerBodies: number; logs: string[]; conversions: number; disabledDuringTransition: boolean | null };
}
describe("offload Opik explicit opt-in with the actual SDK", () => {
  it.each(["missing", "entryOnly"])("does not export from shared environment credentials when %s", kind => {
    const result = probe(kind);
    expect(result.enabled).toBe(false); expect(result.requests).toBe(0); expect(result.markerBodies).toBe(0);
  }, 20_000);
  it.each(["disabled", "nestedDisabled"])("honors explicit disable: %s", kind => {
    const result = probe(kind);
    expect(result.enabled).toBe(false); expect(result.requests).toBe(0);
  }, 20_000);
  it.each(["enabled", "nestedEnabled"])("preserves explicitly enabled trace delivery: %s", kind => {
    const result = probe(kind);
    expect(result.enabled).toBe(true); expect(result.markerBodies).toBeGreaterThan(0);
  }, 20_000);
  it("stops new trace export when an enabled configuration is disabled", () => {
    const result = probe("revoke");
    expect(result.disabledDuringTransition).toBe(true); expect(result.enabled).toBe(false);
    expect(result.requests).toBe(0); expect(result.markerBodies).toBe(0);
  }, 20_000);
  it("permits a new explicit enable after a disabled period", () => {
    const result = probe("reenable");
    expect(result.disabledDuringTransition).toBe(true); expect(result.enabled).toBe(true);
    expect(result.markerBodies).toBeGreaterThan(0);
  }, 20_000);
  it("contains configuration failure without inspecting or logging its payload", () => {
    const result = probe("error");
    expect(result.enabled).toBe(false); expect(result.requests).toBe(0); expect(result.conversions).toBe(0);
    expect(result.logs.join("\n")).not.toContain("synthetic-private-init-error");
  }, 20_000);
});
