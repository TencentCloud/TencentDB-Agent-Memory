#!/usr/bin/env node

import { run } from './lib/cli.mjs';

const exitCode = await run(process.argv.slice(2));
process.exitCode = exitCode;
