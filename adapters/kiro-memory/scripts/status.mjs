#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { healthProject, invalidStatus } from './health.mjs';

export async function statusProject(options) { return healthProject(options); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let status;
  try { status = await statusProject(); } catch { status = invalidStatus(); }
  process.stdout.write(`tdai-memory status: ${status.status}\ngateway: ${status.gateway}\nstate-version: ${status.state_version}\n`);
  process.exitCode = status.status === 'healthy' ? 0 : status.status === 'degraded' ? 1 : 2;
}
