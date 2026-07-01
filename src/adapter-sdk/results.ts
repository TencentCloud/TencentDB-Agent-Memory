import type { AdapterToolResult } from "./types.js";

export type McpJsonValue =
  | null
  | boolean
  | number
  | string
  | McpJsonValue[]
  | { [key: string]: McpJsonValue };

export interface McpContentResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: McpJsonValue | undefined;
}

export interface OpenClawContentResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
}

export function formatUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function toAdapterToolResult(value: unknown): AdapterToolResult {
  if (isAdapterToolResult(value)) return value;
  return { text: formatUnknown(value) };
}

export function toAdapterToolError(error: unknown): AdapterToolResult {
  return {
    text: error instanceof Error ? error.message : String(error),
    isError: true,
  };
}

export function toMcpResult(result: AdapterToolResult | unknown): McpContentResult {
  const normalized = toAdapterToolResult(result);
  return {
    isError: normalized.isError || undefined,
    content: [{ type: "text", text: normalized.text }],
  };
}

export function toOpenClawResult(result: AdapterToolResult): OpenClawContentResult {
  return {
    content: [{ type: "text", text: result.text }],
    details: result.details,
  };
}

function isAdapterToolResult(value: unknown): value is AdapterToolResult {
  if (!value || typeof value !== "object") return false;
  return typeof (value as AdapterToolResult).text === "string";
}
