#!/usr/bin/env node
import { appendLifecycleEvent, captureCurrentTurn, readHookInput } from "./lib.mjs";

const payload = await readHookInput();
await appendLifecycleEvent(payload, "pre_compact", { reason: payload.reason || "context_compaction" });
await captureCurrentTurn(payload, "pre_compact");
