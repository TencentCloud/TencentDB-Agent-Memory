# Adapter SDK Example

This example shows how a new TypeScript host can integrate TencentDB Agent
Memory through the public Adapter SDK subpath:

```ts
import {
  TdaiAdapterRuntime,
  type TdaiPlatformAdapter,
} from "@tencentdb-agent-memory/memory-tencentdb/adapter-sdk";
```

The example adapter maps a hypothetical host's lifecycle payloads to the single
`TdaiPlatformAdapter` interface. The same adapter can run with either:

- `GatewayMemoryOperations`, for platforms that call a local or remote TDAI
  Gateway over HTTP.
- `CoreMemoryOperations`, for TypeScript hosts that can keep `TdaiCore`
  in-process.

## Files

| File | Purpose |
| --- | --- |
| `platform-adapter.ts` | Complete adapter mapping and runtime factory example |
| `tsconfig.json` | Strict type-check config for the example |

## Type-Check

The example imports the public `./adapter-sdk` subpath. In a source checkout,
`tsconfig.json` maps that subpath to the local SDK source so the example can be
checked before packaging:

```bash
npx tsc -p examples/adapter-sdk/tsconfig.json
```

## Integration Steps

1. Implement `TdaiPlatformAdapter` for the host's event and context shapes.
2. Map host session identity to `sessionKey`.
3. Map the host prompt event to `getRecallInput()`.
4. Map the completed turn event to `getCaptureInput()`.
5. Choose `GatewayMemoryOperations` or `CoreMemoryOperations`.
6. Call `runtime.handleRecall()` before the model turn and
   `runtime.handleCapture()` after the turn is committed.
