export class GatewayClient {
  constructor({baseUrl='http://127.0.0.1:18420',apiKey=process.env.TDAI_GATEWAY_API_KEY || 'local-lab-only',serviceId=process.env.TDAI_SERVICE_ID || 'default',timeoutMs=30000}={}) {
    this.baseUrl=baseUrl.replace(/\/$/,''); this.timeoutMs=timeoutMs;
    this.headers={'content-type':'application/json',authorization:`Bearer ${apiKey}`,'x-tdai-service-id':serviceId};
  }
  async post(path, body) {
    const started=performance.now();
    const r=await fetch(`${this.baseUrl}/v2${path}`,{method:'POST',headers:this.headers,body:JSON.stringify(body),signal:AbortSignal.timeout(this.timeoutMs)});
    const envelope=await r.json();
    if(!r.ok || envelope.code!==0)throw new Error(`Gateway ${path}: HTTP ${r.status}, ${envelope.code}: ${envelope.message}`);
    return {data:envelope.data,request_id:envelope.request_id,latency_ms:performance.now()-started};
  }
  async search(scope,query,limit) {
    const r=await this.post('/conversation/search',{...scope,query,limit});
    if(!Array.isArray(r.data.messages))throw new Error('Missing candidates');
    return {items:r.data.messages,request_id:r.request_id,latency_ms:r.latency_ms};
  }
}
