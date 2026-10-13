import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { HttpTransport } from '../src/http.js';
import { V3HttpTransport } from '../src/v3/http.js';

// Real HTTPS requests to synthetic TLS fixtures. No production endpoints or keys.
describe.each([['v2', HttpTransport], ['v3', V3HttpTransport]] as const)('%s transport TLS', (_name, Transport) => {
  let dir: string;
  let server: ReturnType<typeof createServer>;
  let cert: string;
  let endpoint: string;
  let requests = 0;
  let received: Record<string, unknown>;
  const saved = getGlobalDispatcher();
  const tlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sdk-tls-'));
    execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1',
      '-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-subj','/CN=localhost',
      '-addext','subjectAltName=DNS:localhost'], { stdio: 'ignore' });
    cert = readFileSync(join(dir,'cert.pem'),'utf8');
    server = createServer({ key: readFileSync(join(dir,'key.pem')), cert }, async (req, res) => {
      requests++;
      received = { authorization: req.headers.authorization, service: req.headers['x-tdai-service-id'], user: req.headers['x-tdai-user-key'] };
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({code:0,message:'ok',data:{synthetic:true}}));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Synthetic server not listening');
    endpoint = `https://localhost:${address.port}`;
  });
  afterAll(async () => {
    setGlobalDispatcher(saved);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  it('rejects an untrusted certificate by default before sending credentials', async () => {
    const before = requests;
    const transport = new Transport({ endpoint, apiKey:'synthetic-key', serviceId:'synthetic-service', timeout:2000 });
    await expect(transport.post('/synthetic')).rejects.toThrow();
    expect(requests).toBe(before);
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(tlsSetting);
  });
  it('accepts a trusted CA and forwards only the configured identity', async () => {
    const trusted = new Agent({ connect: { ca: cert } });
    setGlobalDispatcher(trusted);
    try {
      const transport = new Transport({ endpoint, apiKey:'synthetic-key', serviceId:'synthetic-service', userKey:'synthetic-user' });
      await expect(transport.post('/synthetic',{value:'synthetic-input'})).resolves.toEqual({synthetic:true});
      expect(received).toEqual({authorization:'Bearer synthetic-key',service:'synthetic-service',user:'synthetic-user'});
      // The same certificate is trusted, but has no IP SAN: reject the hostname.
      const wrongHost = new Transport({ endpoint:endpoint.replace('localhost','127.0.0.1'),apiKey:'synthetic-key',serviceId:'synthetic-service',timeout:2000 });
      const before = requests;
      await expect(wrongHost.post('/synthetic')).rejects.toThrow();
      expect(requests).toBe(before);
    } finally { setGlobalDispatcher(saved); await trusted.close(); }
  });
  it('scopes explicit insecure development mode to that transport', async () => {
    const insecure = new Transport({ endpoint, apiKey:'synthetic-key',serviceId:'synthetic-service',rejectUnauthorized:false });
    try {
      await expect(insecure.post('/synthetic')).resolves.toEqual({synthetic:true});
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(tlsSetting);
      const secure = new Transport({endpoint,apiKey:'synthetic-key',serviceId:'synthetic-service',timeout:2000});
      await expect(secure.post('/synthetic')).rejects.toThrow();
    } finally { await insecure.close(); }
  });
});
