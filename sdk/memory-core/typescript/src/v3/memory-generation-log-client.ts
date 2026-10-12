import { ParamError } from "../errors.js";
import type { MemoryClientConfig, Transport } from "../client.js";
import { V3HttpTransport } from "./http.js";
import type {
  MemoryGenerationLog,
  MemoryGenerationLogGetRequest,
  MemoryGenerationLogListData,
  MemoryGenerationLogListRequest,
} from "./memory-generation-log-types.js";

const ROOT = "/v3/memory-generation-log";
function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

export class MemoryGenerationLogClient {
  private readonly http: Transport;

  constructor(config: MemoryClientConfig);
  constructor(transport: Transport);
  constructor(configOrTransport: MemoryClientConfig | Transport) {
    this.http = "post" in configOrTransport
      ? configOrTransport
      : new V3HttpTransport(Object.fromEntries([
        ["endpoint", configOrTransport.endpoint],
        ["apiKey", configOrTransport.apiKey],
        ["serviceId", configOrTransport.serviceId],
        ["timeout", configOrTransport.timeout],
        ["rejectUnauthorized", configOrTransport.rejectUnauthorized],
      ]) as MemoryClientConfig);
  }

  private requestGet<T>(path: string, query: Record<string, unknown>): Promise<T> {
    return this.http.get ? this.http.get<T>(path, query) : this.http.post<T>(path, query);
  }

  list(params: MemoryGenerationLogListRequest = {}): Promise<MemoryGenerationLogListData> {
    return this.requestGet(`${ROOT}/list`, stripUndefined({ ...params }));
  }

  get(params: MemoryGenerationLogGetRequest): Promise<MemoryGenerationLog> {
    if ("log_id" in params) {
      if (!params.log_id?.trim()) throw new ParamError("log_id must be a non-empty string");
    } else if (!params.memory_id?.trim()) {
      throw new ParamError("memory_id must be a non-empty string");
    }
    return this.requestGet(`${ROOT}/get`, stripUndefined({ ...params }));
  }

  getByMemoryId(memoryId: string, layer: "l1" | "l2" | "l3"): Promise<MemoryGenerationLog> {
    return this.get({ memory_id: memoryId, layer });
  }
}
