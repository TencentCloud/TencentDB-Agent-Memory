#!/usr/bin/env node

import { createCursorCliRuntime, main } from "./cli.js";

const runtime = createCursorCliRuntime({
  executablePath: process.argv[1],
});

process.exitCode = await main(process.argv.slice(2), runtime);
