import type { Logger } from '../../infra/logger.js';
import {
  executeMetaFetch,
  KernelFetchError,
} from '../transport-fetch.js';
import type { MetaEnvelope } from '../envelope.js';
import type { KernelHttpPort } from '../ports/kernel-http-port.js';
import type { KernelCredentials } from '../types.js';

function toErrorEnvelope<T>(err: KernelFetchError, cred: KernelCredentials): MetaEnvelope<T> {
  const message =
    err.code === 504 ? 'KERNEL_TIMEOUT' : err.code === 502 ? 'KERNEL_UNAVAILABLE' : err.message;
  return {
    code: err.code,
    message,
    request_id: cred.requestId ?? '',
    data: null,
  } as MetaEnvelope<T>;
}

export class FetchKernelHttpAdapter implements KernelHttpPort {
  constructor(private readonly logger?: Logger) {}

  async postEnvelope<T>(
    path: string,
    body: unknown,
    cred: KernelCredentials,
  ): Promise<MetaEnvelope<T>> {
    try {
      return await executeMetaFetch<MetaEnvelope<T>>(
        {
          endpoint: cred.endpoint,
          apiKey: cred.apiKey,
          serviceId: cred.instanceId,
          userKey: cred.userKey,
          timeoutMs: cred.timeoutMs,
          requestId: cred.requestId,
          logger: this.logger,
        },
        path,
        body,
        'envelope',
      );
    } catch (err) {
      if (err instanceof KernelFetchError) return toErrorEnvelope<T>(err, cred);
      throw err;
    }
  }

  async getEnvelope<T>(
    path: string,
    cred: KernelCredentials,
  ): Promise<MetaEnvelope<T>> {
    try {
      return await executeMetaFetch<MetaEnvelope<T>>(
        {
          endpoint: cred.endpoint,
          apiKey: cred.apiKey,
          serviceId: cred.instanceId,
          userKey: cred.userKey,
          timeoutMs: cred.timeoutMs,
          requestId: cred.requestId,
          logger: this.logger,
        },
        path,
        null,
        'envelope',
        'GET',
      );
    } catch (err) {
      if (err instanceof KernelFetchError) return toErrorEnvelope<T>(err, cred);
      throw err;
    }
  }
}
