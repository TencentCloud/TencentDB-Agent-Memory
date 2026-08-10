import { createTencentDbMemoryExtension } from "./extension.js";

export { createTencentDbMemoryExtension, type ExtensionDependencies } from "./extension.js";
export type { CaptureTurn, MemoryClientLike, RecallBundle } from "./client.js";

export default createTencentDbMemoryExtension();
