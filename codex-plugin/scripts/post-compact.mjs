#!/usr/bin/env node
import { appendLifecycleEvent, readHookInput, sessionEnd } from "./lib.mjs";

const payload = await readHookInput();
const reason = payload.reason || "context_compaction";
await appendLifecycleEvent(payload, "post_compact", { reason }, { createTurn: false });
await sessionEnd(payload, "post_compact");
