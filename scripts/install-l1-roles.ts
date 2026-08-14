import path from "node:path";
import { installL1RolePackages } from "../src/gateway/l1/l1-role-installer.js";

const dataDir = process.argv[2];
if (!dataDir) {
  process.stderr.write("usage: npm run install:l1-roles -- <data-dir>\n");
  process.exitCode = 2;
} else {
  const installed = installL1RolePackages({ dataDir: path.resolve(dataDir) });
  process.stdout.write(`INSTALLED=${installed.length}\n`);
}
