#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import { resolveConfig } from '../src/core/config.js';
import { StateMigrationService } from '../src/core/state-migration.js';

const projectArg = () => process.argv.length === 4 && process.argv[2] === '--project' && process.argv[3] ? resolve(process.argv[3]) : null;

export async function migrateProject({ project = projectArg(), env = process.env } = {}) {
  if (project === null) throw new Error('args');
  const { config } = await resolveConfig({ env, workspace: project });
  return new StateMigrationService({ stateDir: config.stateDir }).migrate();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await migrateProject(); process.stdout.write('tdai-memory migration: ok\n'); }
  catch { process.stderr.write('tdai-memory migration: failed\n'); process.exitCode = 1; }
}
