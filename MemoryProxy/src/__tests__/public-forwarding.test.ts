import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConfig, DEFAULT_CONFIG } from '../config.js';
import { createApp } from '../server.js';
import { getProxyStorage, __resetProxyStorageForTests } from '../storage/factory.js';
import { joinUrl } from '../upstream-target.js';

// Actual HTTP forwarding to one synthetic loopback server; no production keys/state.
describe('public forwarding after private extension removal', () => {
  const requests: {url:string,body:Record<string,unknown>,authorization?:string}[]=[];
  let server: ReturnType<typeof createServer>;
  let base: string;
  const dir=mkdtempSync(join(tmpdir(),'proxy-public-forwarding-'));
  beforeAll(async()=>{
    server=createServer(async(req,res)=>{
      let text='';for await(const part of req)text+=part;
      const body=JSON.parse(text);requests.push({url:req.url!,body,authorization:req.headers.authorization});
      if(body.stream){
        res.setHeader('content-type','text/event-stream');
        res.end('data: {"id":"synthetic","choices":[{"delta":{"content":"reply-canary"}}]}\n\ndata: [DONE]\n\n');
      } else {
        res.setHeader('content-type','application/json');
        if(req.url?.endsWith('/messages')) {
          res.end(JSON.stringify({id:'synthetic',type:'message',role:'assistant',model:body.model,content:[{type:'text',text:'reply-canary'}],usage:{input_tokens:1,output_tokens:1}}));return;
        }
        if(req.url?.endsWith('/responses')) {
          res.end(JSON.stringify({id:'synthetic',object:'response',model:body.model,output:[{type:'message',id:'msg-1',role:'assistant',content:[{type:'output_text',text:'reply-canary',annotations:[]}]}],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}));return;
        }
        res.end(JSON.stringify({id:'synthetic',model:body.model,choices:[{message:{role:'assistant',content:'reply-canary',tool_calls:[{id:'call-1',type:'function',function:{name:'user_tool',arguments:'{"keep":"private-canary"}'}}]}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
      }
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();if(!address||typeof address==='string')throw Error('fixture not listening');
    base=`http://127.0.0.1:${address.port}/v1`;
  });
  afterEach(()=>{requests.length=0;});
  afterAll(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});__resetProxyStorageForTests();});
  function config(){const c=structuredClone(DEFAULT_CONFIG);c.upstream={url:base,apiKey:'synthetic-upstream-key',agents:{}};c.auth.enabled=false;c.injection.enabled=false;c.sessionInit.enabled=false;c.tdai.enabled=false;c.creditReport.url='';return c;}
  it('forwards the configured model and preserves tool arguments and response content',async()=>{
    const c=config(),app=createApp(c);
    const response=await app.request('/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer synthetic-client-key'},body:JSON.stringify({model:'requested-model',messages:[{role:'user',content:'synthetic-input'}],tools:[{type:'function',function:{name:'user_tool',parameters:{type:'object'}}}]})});
    expect(response.status).toBe(200);
    const output=await response.json();expect(output.choices[0].message.tool_calls[0].function.arguments).toBe('{"keep":"private-canary"}');
    expect(requests).toHaveLength(1);expect(requests[0].url).toBe('/v1/chat/completions');
    expect(requests[0].body.model).toBe('requested-model');expect(requests[0].authorization).toBe('Bearer synthetic-upstream-key');
    expect(JSON.stringify(requests[0].body)).toContain('synthetic-input');
  });
  it.each([
    ['/claude-code/default/v1/messages','/v1/messages',{max_tokens:64,messages:[{role:'user',content:'synthetic-input'}]}],
    ['/codex/default/v1/responses','/v1/responses',{input:[{role:'user',content:'synthetic-input'}]}],
    ['/workbuddy/default/v1/responses','/v1/responses',{input:[{role:'user',content:'synthetic-input'}]}],
    ['/opencode/default/v1/chat/completions','/v1/chat/completions',{messages:[{role:'user',content:'synthetic-input'}]}],
  ] as const)('forwards normal protocol endpoint %s',async (url,expectedPath,payload)=>{
    const response=await createApp(config()).request(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer synthetic-client-key'},body:JSON.stringify({model:'requested-model',...payload})});
    expect(response.status).toBe(200);expect(await response.text()).toContain('reply-canary');
    expect(requests).toHaveLength(1);expect(requests[0].url).toBe(expectedPath);expect(requests[0].body.model).toBe('requested-model');
  });
  it('preserves streaming data without a private response filter',async()=>{
    const response=await createApp(config()).request('/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'requested-model',stream:true,messages:[{role:'user',content:'synthetic-input'}]})});
    expect(response.status).toBe(200);expect(await response.text()).toContain('reply-canary');expect(requests).toHaveLength(1);
  });
  it.each(['/claude-code/default/cost-guard/v1/messages','/codebuddy/default/cost-guard/pre/v1/chat/completions','/codex/default/cost-guard/cheap/responses','/workbuddy/default/cost-guard/responses'])('rejects retired URL %s before forwarding',async url=>{
    const response=await createApp(config()).request(url,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    expect(response.status).toBe(404);expect(requests).toHaveLength(0);
  });
  it.each(['costGuard: {enabled: true}','costGuard: {enabled: false}','costGuard: {requestPrepare: {enabled: true}}','costGuard: {controlPlane: {enabled: true}}','badcaseCollector: {}'])('rejects legacy extension settings: %s',yaml=>{
    const path=join(dir,'config.yaml');writeFileSync(path,yaml);expect(()=>buildConfig({configFile:path})).toThrow(/removed/);
  });
  it.each(['storage: {enabled: true, backend: cos}','storage: {enabled: false, backend: sqlite, cos: {}}'])('requires an explicit migration for old COS config: %s',yaml=>{
    const path=join(dir,'config.yaml');writeFileSync(path,yaml);expect(()=>buildConfig({configFile:path})).toThrow(/COS storage was removed/);
  });
  it('rejects removed COS before disabled-storage or singleton fallbacks',()=>{
    const c=config();getProxyStorage(c.storage);
    expect(()=>getProxyStorage({...c.storage,enabled:false,backend:'cos'} as any)).toThrow(/COS storage was removed/);
  });
  it('keeps public endpoint joining for Anthropic, Chat Completions and Responses',()=>{
    expect(joinUrl('https://upstream.example','/v1/messages')).toBe('https://upstream.example/v1/messages');
    expect(joinUrl('https://upstream.example/v1','/v1/chat/completions')).toBe('https://upstream.example/v1/chat/completions');
    expect(joinUrl('https://upstream.example/v1','/v1/responses')).toBe('https://upstream.example/v1/responses');
  });
  it('loads the shipped configuration example without removed extension fields',()=>{
    const c=buildConfig({configFile:new URL('../../config.example.yaml',import.meta.url).pathname});
    expect(c).not.toHaveProperty('costGuard');expect(c.storage).not.toHaveProperty('cos');expect(c.storage.backend).toBe('sqlite');
  });
});
