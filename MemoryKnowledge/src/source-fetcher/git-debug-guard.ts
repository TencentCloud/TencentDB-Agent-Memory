/**
 * Side-effect guard: neutralize simple-git DEBUG *before* `simple-git` is imported.
 *
 * simple-git uses the `debug` package; once a namespace is enabled at module load,
 * later changes to `process.env.DEBUG` do not disable already-created loggers.
 * Import this module first from git-fetcher.ts (ESM evaluates side-effect imports
 * in source order before subsequent imports).
 */

import { stripSimpleGitDebug } from "./git-auth.js";

stripSimpleGitDebug();
