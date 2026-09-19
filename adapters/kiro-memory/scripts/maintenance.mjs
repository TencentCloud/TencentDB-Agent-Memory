#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import { resolveConfig } from '../src/core/config.js';
import { ArchiveService } from '../src/core/archive-service.js';
import { GatewayClient } from '../src/core/gateway-client.js';
import { Outbox } from '../src/core/outbox.js';
import { StateMaintenanceService } from '../src/core/state-maintenance.js';
import { TurnStore } from '../src/core/turn-store.js';

const parse = () => {
  const apply = process.argv.includes('--apply');
  const index = process.argv.indexOf('--project');
  if (index === -1 || !process.argv[index + 1]) throw new Error('args');
  return { project: resolve(process.argv[index + 1]), apply };
};

export async function maintainProject({ project, apply = false, env = process.env } = {}) {
  const args = project ? { project: resolve(project), apply } : parse();
  const { config } = await resolveConfig({ env, workspace: args.project });
  let archiveService;
  if (args.apply) {
    const gatewayClient = new GatewayClient(config);
    const outbox = new Outbox({ stateDir: config.stateDir, gatewayClient });
    archiveService = new ArchiveService({ config, turnStore: new TurnStore({ stateDir: config.stateDir }), outbox });
  }
  const service = new StateMaintenanceService({ stateDir: config.stateDir, archiveService });
  const plan = await service.plan();
  const summary = {
    truncated: plan.truncated,
    items: plan.items.map((item) => ({ identifier: item.identifier, category: item.category, action: item.action })),
  };
  if (args.apply) summary.result = await service.apply(plan);
  return summary;
}

export const maintenanceExitCode = (summary) => summary?.truncated === true ? 1 : 0;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const summary = await maintainProject();
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    process.exitCode = maintenanceExitCode(summary);
  }
  catch { process.stderr.write('tdai-memory maintenance: failed\n'); process.exitCode = 1; }
}
