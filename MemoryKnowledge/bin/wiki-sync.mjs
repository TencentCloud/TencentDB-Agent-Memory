#!/usr/bin/env node
// Thin launcher: loads the compiled wiki-sync CLI.
// Build: npm run build   ·   Use: knowledge-wiki-sync --help
//
// The dist module cannot detect that it was launched from here (argv[1] is this
// file), so the entry is called explicitly rather than left to its own guard.

import { main } from "../dist/wiki-sync.mjs";

void main();