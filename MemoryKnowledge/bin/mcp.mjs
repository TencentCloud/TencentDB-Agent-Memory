#!/usr/bin/env node
import { fileURLToPath } from "node:url";

const distPath = fileURLToPath(new URL("../dist/mcp/server.mjs", import.meta.url));
process.argv[1] = distPath;

await import("../dist/mcp/server.mjs");
