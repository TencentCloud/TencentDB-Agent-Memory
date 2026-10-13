import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { executeMetaFetch } from '../../src/panel/kernel/transport-fetch.js';
import { HttpKnowledgeClient } from '../../src/panel/kernel/adapters/http-knowledge-client.js';
import { ensureKnowledgeLlmBinding } from '../../src/panel/startup/ensure-knowledge-llm-binding.js';
import type { InstanceEntry } from '../../src/panel/config/instance-registry.js';
import type { Logger } from '../../src/panel/infra/logger.js';

const secret='synthetic-private-content';
async function fixture(status:number,response:unknown,run:(endpoint:string)=>Promise<void>){
  let redirected=0;const sink=createServer((req,res)=>{redirected++;req.resume();res.end(JSON.stringify({code:0,data:{ok:true}}));});
  await new Promise<void>(r=>sink.listen(0,'127.0.0.1',r));const target=sink.address();if(!target||typeof target==='string')throw Error('address');
  const source=createServer((req,res)=>{req.resume();if(status>=300&&status<400){res.writeHead(status,{location:`http://127.0.0.1:${target.port}/capture`});res.end();}else{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(response));}});
  await new Promise<void>(r=>source.listen(0,'127.0.0.1',r));const address=source.address();if(!address||typeof address==='string')throw Error('address');
  try{await run(`http://127.0.0.1:${address.port}`);expect(redirected).toBe(0);}
  finally{source.closeAllConnections();sink.closeAllConnections();await Promise.all([new Promise<void>(r=>source.close(()=>r())),new Promise<void>(r=>sink.close(()=>r()))]);}
}
describe('Panel authenticated transport',()=>{
  for(const kind of ['metadata','knowledge'] as const){
    it.each([200,301,302,303,307,308])(`${kind} accepts direct responses and rejects redirect %s`,async status=>{
      await fixture(status,{code:0,data:{ok:true}},async endpoint=>{
        const promise=kind==='metadata'?executeMetaFetch({endpoint,apiKey:'synthetic-key',serviceId:'fixture',userKey:'synthetic-user-key'},'/v3/test',{content:secret},'data'):
          new HttpKnowledgeClient({baseUrl:endpoint,authToken:'synthetic-key',serviceId:'fixture'}).wikiGet('synthetic-wiki');
        if(status===200)await expect(promise).resolves.toEqual({ok:true});else await expect(promise).rejects.toThrow();
      });
    });
  }
  it.each(['data','envelope'] as const)('does not log request/response payloads in %s mode',async mode=>{
    const info=vi.fn(),warn=vi.fn();const logger={info,warn} as unknown as Logger;
    await fixture(200,{code:0,data:{content:secret,password:'synthetic-password'}},async endpoint=>{
      const value=await executeMetaFetch({endpoint,apiKey:'synthetic-key',serviceId:'fixture',logger},'/v3/test',{content:secret,token:'synthetic-token'},mode);
      expect(JSON.stringify(value)).toContain(secret);const recorded=JSON.stringify([info.mock.calls,warn.mock.calls]);
      for(const marker of [secret,'synthetic-password','synthetic-token'])expect(recorded).not.toContain(marker);
      expect(info).toHaveBeenCalled();
    });
  });
  it.each(['data','envelope'] as const)('does not log business error messages in %s mode',async mode=>{
    const info=vi.fn(),warn=vi.fn();const logger={info,warn} as unknown as Logger;
    await fixture(200,{code:403,message:secret,data:{token:'synthetic-token'}},async endpoint=>{
      const request=executeMetaFetch({endpoint,apiKey:'synthetic-key',serviceId:'fixture',logger},'/v3/test',{},mode);
      if(mode==='data')await expect(request).rejects.toThrow(secret);else expect(JSON.stringify(await request)).toContain(secret);
      const recorded=JSON.stringify([info.mock.calls,warn.mock.calls]);expect(recorded).not.toContain(secret);expect(recorded).not.toContain('synthetic-token');expect(warn).toHaveBeenCalled();
    });
  });
});

describe('Panel startup Knowledge binding transport',()=>{
  it.each([200,301,302,303,307,308])('canonical binding endpoint accepts 200 and rejects redirect %s',async status=>{
    await fixture(status,{code:0,data:{}},async endpoint=>{
      const instance={instance_id:'fixture'} as InstanceEntry;
      const logger={info:vi.fn(),warn:vi.fn()} as unknown as Logger;
      const cached=new Map([['fixture',{service_id:'fixture',mode:'proxy',proxy_base_url:null,base_url:null,has_api_key:true,enabled:true}]]);
      const request=ensureKnowledgeLlmBinding(instance,{knowledgeBaseUrl:endpoint,knowledgeAuthToken:'synthetic-key',proxyBaseUrl:'http://127.0.0.1:8096',timeoutMs:2000},logger,cached);
      if(status===200)await expect(request).resolves.toBe('bound');else await expect(request).rejects.toThrow();
    });
  });
});
