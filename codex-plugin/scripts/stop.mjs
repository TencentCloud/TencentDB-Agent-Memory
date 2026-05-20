#!/usr/bin/env node
import { captureCurrentTurn, maybeFlushCapturedTurns, readHookInput } from "./lib.mjs";

const payload = await readHookInput();
const capture = await captureCurrentTurn(payload, "stop");
await maybeFlushCapturedTurns(payload, capture, "periodic_stop_flush");
