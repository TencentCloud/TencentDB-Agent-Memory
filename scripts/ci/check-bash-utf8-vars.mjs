#!/usr/bin/env node

/**
 * Bash 3.2 (the version bundled with macOS) reads bytes >= 0x80 as part of a
 * variable name. `$name，` therefore becomes a lookup for `name<multibyte>`,
 * which fails under `set -u`. Require braces whenever a variable is followed
 * by non-ASCII text.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync(
  "git",
  ["ls-files", "-z", "--", "*.sh", "*.bash"],
  { encoding: "utf8" },
).split("\0").filter(Boolean);

const unbracedBeforeUnicode = /\$([A-Za-z_][A-Za-z0-9_]*)(?=[^\x00-\x7F])/g;
const failures = [];

for (const file of files) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    unbracedBeforeUnicode.lastIndex = 0;
    let match;
    while ((match = unbracedBeforeUnicode.exec(line)) !== null) {
      failures.push({
        file,
        line: index + 1,
        variable: match[1],
        text: line.trim(),
      });
    }
  });
}

if (failures.length > 0) {
  console.error("Unbraced shell variables before non-ASCII text:");
  for (const failure of failures) {
    console.error(
      `${failure.file}:${failure.line}: use \${${failure.variable}} in: ${failure.text}`,
    );
  }
  process.exit(1);
}

console.log(`Bash UTF-8 variable check passed (${files.length} scripts).`);
