#!/usr/bin/env node
import { main } from "../dist/replay-l1.mjs";

main().catch((error) => {
  console.error(`replay-l1 failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
