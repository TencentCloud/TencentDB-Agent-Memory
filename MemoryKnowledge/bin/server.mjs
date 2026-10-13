#!/usr/bin/env node
import { fileURLToPath } from "node:url";

const distPath = fileURLToPath(new URL("../dist/server.mjs", import.meta.url));
process.argv[1] = distPath;

await import("../dist/server.mjs");
