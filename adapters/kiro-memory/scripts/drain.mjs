#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createRuntimeDependencies } from '../src/cli.js';
import { resolveConfig } from '../src/core/config.js';
import { OutboxDrainService } from '../src/core/outbox-drain-service.js';

const DEFAULTS = { maxItems: 50, concurrency: 4, budgetMs: 30_000 };
const summaryFields = ['selected', 'processed', 'acknowledged', 'failed', 'deferred', 'manualReview', 'durationMs'];
const optionNames = new Map([
  ['--max-items', 'maxItems'],
  ['--concurrency', 'concurrency'],
  ['--budget-ms', 'budgetMs'],
]);

export function parseDrainArgs(argv) {
  if (!Array.isArray(argv)) throw new Error('args');
  const seen = new Set();
  const parsed = { ...DEFAULTS };
  let project;
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (typeof name !== 'string' || typeof value !== 'string' || value.length === 0
      || value.startsWith('--') || seen.has(name)) throw new Error('args');
    seen.add(name);
    if (name === '--project') {
      project = resolve(value);
      continue;
    }
    const key = optionNames.get(name);
    if (!key || !/^\d+$/.test(value)) throw new Error('args');
    parsed[key] = Number(value);
  }
  if (project === undefined
    || !Number.isInteger(parsed.maxItems) || parsed.maxItems < 1 || parsed.maxItems > 100
    || !Number.isInteger(parsed.concurrency) || parsed.concurrency < 1 || parsed.concurrency > 8
    || !Number.isInteger(parsed.budgetMs) || parsed.budgetMs < 100 || parsed.budgetMs > 60_000) {
    throw new Error('args');
  }
  return { project, options: parsed };
}

export async function drainProject({
  project,
  env = process.env,
  options,
  resolveRuntimeConfig = async (workspace) => (await resolveConfig({ env, workspace })).config,
  createDependencies = createRuntimeDependencies,
  createDrainService = (outbox) => new OutboxDrainService({ outbox }),
} = {}) {
  const workspace = resolve(project);
  const config = await resolveRuntimeConfig(workspace);
  const { outbox } = createDependencies(config);
  return createDrainService(outbox).drain(options);
}

export async function runDrainCli({ argv = process.argv.slice(2), env = process.env, drain = drainProject } = {}) {
  try {
    const args = parseDrainArgs(argv);
    const summary = await drain({ ...args, env });
    const safeSummary = Object.fromEntries(summaryFields.map((field) => {
      const value = summary?.[field];
      if (!Number.isFinite(value) || value < 0) throw new Error('summary');
      return [field, value];
    }));
    return { exitCode: 0, stdout: `${JSON.stringify(safeSummary)}\n`, stderr: '' };
  } catch {
    return { exitCode: 1, stdout: '', stderr: 'tdai-memory drain: failed\n' };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runDrainCli();
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
