#!/usr/bin/env node

// Re-export the package hook launcher so Gemini CLI extensions can invoke it
// with a single command: node ${extensionPath}/hook.mjs

await import("../bin/gemini-cli-hook.mjs");
