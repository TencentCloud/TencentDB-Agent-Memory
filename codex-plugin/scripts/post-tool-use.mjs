#!/usr/bin/env node
import {
  appendToolEvent,
  maybeOffloadToolOutput,
  postToolOffloadHookOutput,
  readHookInput
} from "./lib.mjs";

const payload = await readHookInput();
const offload = await maybeOffloadToolOutput(payload);
await appendToolEvent(payload, "post_tool_use", offload ? {
  toolOutputOffloaded: true,
  toolOutputNodeId: offload.nodeId,
  toolOutputPolicy: offload.policy,
  toolOutputPath: offload.outputPath,
  toolOutputJsonlPath: offload.offloadJsonlPath,
  toolOutputCanvasPath: offload.canvasPath,
  toolOutputOriginalChars: offload.originalChars,
  toolOutputStoredChars: offload.storedChars,
  toolOutputSummary: offload.summary
} : {});
process.stdout.write(postToolOffloadHookOutput(offload));
