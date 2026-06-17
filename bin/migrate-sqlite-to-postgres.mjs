#!/usr/bin/env node

// Thin wrapper: runs the pre-compiled PostgreSQL migration CLI entry.
// Build first: npm run build:migrate-sqlite-to-postgres

import path from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const entryScript = path.resolve(thisDir, "../scripts/migrate-sqlite-to-postgres/dist/scripts/migrate-sqlite-to-postgres/cli-entry.js");

import(entryScript);
