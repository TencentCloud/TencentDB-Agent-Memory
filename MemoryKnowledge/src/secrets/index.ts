/**
 * Secrets 模块导出 — SecretStore 抽象 + 自托管信封加密实现（949spec §5/§6）。
 */
export * from "./secret-store.js";
export {
  EnvelopeSecretStore,
  fingerprintOf,
  generateMasterKey,
  resolveMasterKeyFromEnv,
  type EnvelopeSecretStoreOptions,
} from "./envelope-store.js";
