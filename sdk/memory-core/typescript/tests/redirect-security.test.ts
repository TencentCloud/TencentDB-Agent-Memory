import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createServer as httpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { HttpTransport } from '../src/http.js';
import { V3HttpTransport } from '../src/v3/http.js';
import { MemoryFileReader, StsCredential, StsCredentialManager } from '../src/cos.js';

const statuses = [200, 301, 302, 303, 307, 308];
const secret = 'synthetic-private-content';
const credential = { CosUrl: 'https://fixture.cos.test.myqcloud.com', TmpSecretId: 'synthetic-id',
  TmpSecretKey: 'synthetic-key', TmpToken: 'synthetic-cos-token', ExpirationTime: new Date(Date.now()+3600000).toISOString(), PathPrefix: 'fixture/' };
let directory: string;
let tls: { key: Buffer; cert: Buffer };
let agent: Agent;
const saved = getGlobalDispatcher();
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'sdk-redirect-'));
  execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1',
    '-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem'),'-subj','/CN=localhost',
    '-addext','subjectAltName=DNS:localhost'], {stdio:'ignore'});
  tls = { key: readFileSync(join(directory,'key.pem')), cert: readFileSync(join(directory,'cert.pem')) };
  agent = new Agent({connect:{ca:tls.cert}});
  setGlobalDispatcher(agent);
});
afterAll(async () => {setGlobalDispatcher(saved);await agent.close();rmSync(directory,{recursive:true,force:true});});

async function fixture(status: number, secure: boolean, response: unknown,
  run: (endpoint: string, records: Array<{headers: IncomingMessage['headers'];body:string}>) => Promise<void>) {
  let redirected = 0;
  const records: Array<{headers: IncomingMessage['headers'];body:string}> = [];
  const destination = httpServer((req,res) => {redirected++;req.resume();res.end(JSON.stringify({code:0,data:{ok:true}}));});
  await new Promise<void>(resolve => destination.listen(0,'127.0.0.1',resolve));
  const dest = destination.address();if(!dest || typeof dest==='string')throw Error('missing address');
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
      records.push({headers:req.headers,body});
      if(status!==200){res.writeHead(status,{location:`http://127.0.0.1:${dest.port}/capture`});res.end();}
      else {res.setHeader('content-type','application/json');res.end(typeof response==='string'?response:JSON.stringify(response));}
    });
  };
  const source = secure ? httpsServer(tls,handle) : httpServer(handle);
  await new Promise<void>(resolve=>source.listen(0,'127.0.0.1',resolve));
  const address=source.address();if(!address || typeof address==='string')throw Error('missing address');
  try {await run(`${secure?'https://localhost':'http://127.0.0.1'}:${address.port}`,records);expect(redirected).toBe(0);}
  finally {source.closeAllConnections();destination.closeAllConnections();await Promise.all([
    new Promise<void>(resolve=>source.close(()=>resolve())),new Promise<void>(resolve=>destination.close(()=>resolve()))]);}
}

for (const kind of ['v2 POST','v3 POST','v3 GET'] as const) {
  describe(kind,()=>{
    it.each(statuses)('accepts direct 200 and rejects redirect %s without leaking user key/body',async status=>{
      await fixture(status,false,{code:0,data:{ok:true}},async (endpoint,records)=>{
        const options={endpoint,apiKey:'synthetic-service-key',serviceId:'synthetic-service',userKey:'synthetic-user-key',timeout:2000};
        const transport=kind==='v2 POST'?new HttpTransport(options):new V3HttpTransport(options);
        try {
          const request=kind==='v3 GET'?(transport as V3HttpTransport).get('/v3/test',{message:secret}):transport.post('/v3/test',{message:secret});
          if(status===200)await expect(request).resolves.toEqual({ok:true});else await expect(request).rejects.toThrow();
          expect(records).toHaveLength(1);expect(records[0].headers['x-tdai-user-key']).toBe('synthetic-user-key');
          if(kind!=='v3 GET')expect(JSON.parse(records[0].body).message).toBe(secret);
        } finally {await transport.close();}
      });
    });
  });
}

describe('COS credentials and object transport',()=>{
  it.each(statuses)('STS endpoint accepts 200 and rejects redirect %s',async status=>{
    await fixture(status,false,credential,async (endpoint,records)=>{
      const manager=new StsCredentialManager({endpoint,apiKey:'synthetic-service-key',serviceId:'synthetic-service',timeout:2000});
      if(status===200)expect((await manager.getCredential()).token).toBe('synthetic-cos-token');
      else await expect(manager.getCredential()).rejects.toThrow();
      expect(records).toHaveLength(1);expect(records[0].headers.authorization).toBe('Bearer synthetic-service-key');
    });
  });
  it.each(statuses)('signed HTTPS object accepts 200 and rejects redirect %s without forwarding STS token',async status=>{
    await fixture(status,true,secret,async (endpoint,records)=>{
      const cred=new StsCredential(credential);
      Object.defineProperty(cred,'cosHost',{value:new URL(endpoint).host});
      const manager={getCredential:async()=>cred,invalidate:()=>{throw Error('unexpected credential refresh');}} as unknown as StsCredentialManager;
      const reader=new MemoryFileReader(manager,2000);
      if(status===200)await expect(reader.read('persona.md')).resolves.toBe(secret);
      else await expect(reader.read('persona.md')).rejects.toThrow();
      expect(records).toHaveLength(1);expect(records[0].headers['x-cos-security-token']).toBe('synthetic-cos-token');
      expect(records[0].headers.authorization).toContain('q-sign-algorithm=sha1');
    });
  });
});
