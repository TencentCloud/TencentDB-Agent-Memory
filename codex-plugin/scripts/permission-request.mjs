#!/usr/bin/env node
import { appendLifecycleEvent, compact, readHookInput } from "./lib.mjs";

const payload = await readHookInput();
await appendLifecycleEvent(payload, "permission_request", {
  toolName: payload.tool_name || payload.toolName || payload.tool?.name || "",
  permission: compact(
    payload.permission ||
      payload.permission_request ||
      payload.permissionRequest ||
      payload.request ||
      payload,
    3000
  )
});
