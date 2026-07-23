import path from "node:path";
import { createHash } from "node:crypto";

export interface QwenCodeSessionKeyOptions {
  cwd: string;
  sessionId?: string;
  explicitSessionKey?: string;
}

function sha256Short(value: string, chars = 12): string {
  return createHash("sha256").update(value).digest("hex").slice(0, chars);
}

function canonicalizeCwd(cwd: string): string {
  const input = cwd || process.cwd();
  const resolved = /^[a-zA-Z]:[\\/]/.test(input)
    ? path.win32.resolve(input).replace(/\\/g, "/")
    : path.resolve(input).replace(/\\/g, "/");
  const trimmed = resolved.replace(/\/+$/, "");
  return /^[a-zA-Z]:\//.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

function sanitizeSegment(value: string, fallback: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return sanitized || fallback;
}

export function createQwenCodeSessionKey(options: QwenCodeSessionKeyOptions): string {
  const explicit = options.explicitSessionKey?.trim();
  if (explicit) return explicit;

  const canonicalCwd = canonicalizeCwd(options.cwd);
  const projectName = sanitizeSegment(path.basename(canonicalCwd), "project");
  const projectHash = sha256Short(canonicalCwd);
  const sessionHash = sha256Short(options.sessionId || canonicalCwd, 10);
  return `qwen:${projectName}-${projectHash}:${sessionHash}`;
}

export function getProjectIdForQwenCode(cwd: string): string {
  const canonicalCwd = canonicalizeCwd(cwd);
  return `${sanitizeSegment(path.basename(canonicalCwd), "project")}-${sha256Short(canonicalCwd)}`;
}
