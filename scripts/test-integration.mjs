#!/usr/bin/env node
/** Run every local integration suite; report all failures instead of stopping early. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const suites = [
  'MemoryCore',
  'MemoryProxy',
  'MemoryPanel',
  'MemoryKnowledge',
  'sdk/memory-core/typescript',
].map((directory) => ({ directory, command: 'npm', args: ['run', 'test:integration'] }));
suites.push({
  directory: 'sdk/memory-core/python',
  command: process.env.PYTHON || 'python3',
  args: ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '-m', 'integration'],
});

const failures = [];
for (const { directory, command, args } of suites) {
  console.log(`\nRunning ${directory}`);
  const result = spawnSync(command, args, {
    cwd: resolve(root, directory),
    stdio: 'inherit',
    // Windows npm is a .cmd launcher. All arguments here are fixed constants.
    shell: process.platform === 'win32' && command === 'npm',
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) failures.push(directory);
}

if (failures.length) {
  console.error(`\nFailed suites: ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${suites.length} integration suites passed.`);
}
