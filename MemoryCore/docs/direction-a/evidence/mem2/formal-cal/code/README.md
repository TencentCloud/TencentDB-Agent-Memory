# Post-recovery materializer

`post_recovery_materializer.ts` is a zero-provider, deterministic adapter. It verifies the frozen recovery and runtime bindings, merges original and certified-recovery arms by the original pair identity, rebuilds fixed4 references with the existing production builder, and invokes the frozen A1 `a1Bound` kernel for the pre-Y V/G alpha plans.

Run from `MemoryCore`:

```powershell
.\node_modules\.bin\tsx.cmd ..\Direction_A_Mem2_A1_CAL_Formal_Inference_v1\code\post_recovery_materializer.ts
```

The adapter does not read secrets or execute acquisition. It intentionally does not create a post-Y DeltaV alpha plan: the frozen CAL bundle contains V/G plans only.
