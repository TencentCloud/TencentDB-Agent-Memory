/**
 * Ambient type stubs for optional peer dependencies that are NOT installed in
 * this workspace but are referenced by committed code:
 *
 * - `openclaw/plugin-sdk/core` — OpenClaw plugin SDK (peerDependency). Only
 *   `OpenClawPluginApi` is imported, always as a type.
 * - `node-llama-cpp` — optional local-embedding backend (peerDependency).
 *   Imported only via a typed dynamic import inside LocalEmbeddingService.
 *
 * Script-style (no top-level import/export) so the `declare module` blocks act
 * as ambient module declarations for the unresolvable packages.
 *
 * The gateway subsystem never uses these at runtime; the stubs exist so
 * `bunx tsc --noEmit -p tsconfig.check.json` can typecheck the gateway + core
 * tree without the SDK packages being installed.
 */
declare module "openclaw/plugin-sdk/core" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type OpenClawPluginApi = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _default: any;
  export default _default;
}

declare module "node-llama-cpp" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _: any;
  export = _;
}
