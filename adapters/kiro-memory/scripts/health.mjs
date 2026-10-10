#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import { resolveConfig } from '../src/core/config.js';
import { DiagnosticService } from '../src/core/diagnostic-service.js';
import { GatewayClient } from '../src/core/gateway-client.js';

const projectArg = () => {
  const index = process.argv.indexOf('--project');
  return index === -1 || !process.argv[index + 1] ? null : resolve(process.argv[index + 1]);
};
export const invalidStatus = () => ({ status: 'invalid_config', gateway: 'not_checked', config_sources: [], state_version: 1, migration_required: true, outbox_pending: 0, turns: 0, markers: 0, locks: 0, last_successful_operation_at: null, warnings: ['invalid_config'] });

export async function healthProject({ project = projectArg(), env = process.env } = {}) {
  if (project === null) throw new Error('Invalid project');
  const resolved = await resolveConfig({ env, workspace: project });
  return new DiagnosticService({ config: resolved.config, provenance: resolved.provenance, gatewayClient: new GatewayClient(resolved.config) }).getStatus({ includeGateway: true });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let status;
  try { status = await healthProject(); } catch { status = invalidStatus(); }
  process.stdout.write(`${JSON.stringify(status)}\n`);
  process.exitCode = status.status === 'healthy' ? 0 : status.status === 'degraded' ? 1 : 2;
}
