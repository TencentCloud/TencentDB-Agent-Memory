import {register} from '../vendor/TencentDB-Agent-Memory/MemoryCore/node_modules/tsx/dist/esm/api/index.mjs';
register();
await import('./v9-selection-worker.mjs');
