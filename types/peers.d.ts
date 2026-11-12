/**
 * Ambient declarations for peerDependencies that are not installed in this
 * repo's dev environment.
 *
 * `openclaw` and `node-llama-cpp` are declared in package.json under
 * `peerDependencies` — the consuming host installs them, and tsdown marks both
 * as external so they are never bundled. Without these stubs `tsc` reports
 * TS2307 for every import of them, which would drown out real findings.
 *
 * These are deliberately untyped (`any`). If a peer is ever added as a real
 * devDependency, delete the matching block so the package's own types win —
 * an ambient declaration here would otherwise shadow them silently.
 */

// The only thing this repo imports from the OpenClaw SDK is the plugin API
// type. Widening it to `any` keeps the OpenClaw adapter checkable against the
// rest of the codebase without vendoring the SDK's type surface.
declare module "openclaw/plugin-sdk/core" {
  /**
   * Structural stand-in for the real plugin API.
   *
   * The index signature keeps every property accessible as `any`, while the
   * two explicit members give hook and CLI callbacks a contextual type — a
   * bare `any` would make each of their parameters an implicit-any error.
   */
  export type OpenClawPluginApi = {
    [key: string]: any;
    on(event: string, handler: (...args: any[]) => any): any;
    registerCli(register: (ctx: any) => any, options?: any): any;
  };
}

// Imported dynamically in src/core/store/embedding.ts and immediately cast,
// so a shorthand ambient module is sufficient here.
declare module "node-llama-cpp";
