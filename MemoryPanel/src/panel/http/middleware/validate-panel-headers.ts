import { createMiddleware } from 'hono/factory';
import { InstanceRegistryError } from '../../config/instance-registry.js';
import {
  META_HEADER_SERVICE_ID,
  META_HEADER_USER_KEY,
} from '../../kernel/headers.js';
import type { PanelDeps } from '../../panel-deps.js';
import { respondControlError } from '../envelope.js';
import { readCookie } from '../../auth/cookies.js';
const AUTH_VERIFY = 'auth/verify';

export interface PanelMetaContext {
  instanceId: string;
  gatewayEndpoint: string;
  gatewayApiKey: string;
  userKey?: string;
  authMethod?: 'user_key' | 'idp';
  userId?: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    panelMeta: PanelMetaContext;
  }
}

function readAction(path: string): string {
  const marker = '/meta/';
  const idx = path.indexOf(marker);
  if (idx < 0) return '';
  return path.slice(idx + marker.length);
}

export function validatePanelMetaHeaders(deps: PanelDeps) {
  return createMiddleware(async (c, next) => {
    const action = readAction(c.req.path);
    const instanceId = c.req.header(META_HEADER_SERVICE_ID)?.trim();
    if (!instanceId) {
      return respondControlError(c, 400, 'MISSING_INSTANCE_ID');
    }

    let entry;
    try {
      entry = deps.instanceRegistry.resolve(instanceId);
    } catch (err) {
      if (err instanceof InstanceRegistryError && err.code === 400) {
        return respondControlError(c, 400, 'INVALID_INSTANCE');
      }
      throw err;
    }

    const omitUserKey = action === AUTH_VERIFY;
    const headerUserKey = c.req.header(META_HEADER_USER_KEY)?.trim();
    const idpSession = !headerUserKey && !omitUserKey
      ? deps.auth.resolveSession(
          entry.instance_id,
          readCookie(c.req.header('cookie'), deps.config.auth.sessionCookieName),
        )
      : null;
    const userKey = headerUserKey || idpSession?.userKey;
    if (!omitUserKey && !userKey) {
      return respondControlError(c, 400, 'MISSING_USER_KEY');
    }

    c.set('panelMeta', {
      instanceId: entry.instance_id,
      gatewayEndpoint: entry.gateway_endpoint,
      gatewayApiKey: entry.api_key,
      userKey: omitUserKey ? undefined : userKey,
      authMethod: headerUserKey ? 'user_key' : idpSession ? 'idp' : undefined,
      userId: idpSession?.coreUserId,
    });
    await next();
  });
}
