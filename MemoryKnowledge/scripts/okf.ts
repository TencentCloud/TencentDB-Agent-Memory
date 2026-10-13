/** Offline bundle utility. Run via npm run okf -- <command> ... */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { importBundle, exportBundle, validateBundle, type BundleFile } from "../src/engines/wiki/okf-bundle.js";
import { migrateOkfPage } from "../src/engines/wiki/okf-migrate.js";

const [command, input, output, ...flags] = process.argv.slice(2);
if (!input) throw new Error("Usage: okf export DIR OUT.json | validate BUNDLE.json | import BUNDLE.json DIR [--overwrite] | migrate IN.md OUT.md");
const read = () => JSON.parse(readFileSync(input, "utf-8")) as { files: BundleFile[] };
const save = (data: string) => {
  if (!output || existsSync(output)) throw new Error("Output must be a new file (preserve original for rollback)");
  writeFileSync(output, data, { flag: "wx" });
};
switch (command) {
  case "export": save(JSON.stringify({ files: exportBundle(input) }, null, 2) + "\n"); break;
  case "validate": console.log(JSON.stringify(validateBundle(read().files), null, 2)); break;
  case "import":
    if (!output) throw new Error("Destination directory required");
    console.log(JSON.stringify(importBundle(output, read().files, flags.includes("--overwrite")), null, 2)); break;
  case "migrate": {
    const result = migrateOkfPage(readFileSync(input, "utf-8"));
    save(result.content); console.log(JSON.stringify({ changed: result.changed, warnings: result.warnings })); break;
  }
  default: throw new Error("Unknown OKF command");
}
