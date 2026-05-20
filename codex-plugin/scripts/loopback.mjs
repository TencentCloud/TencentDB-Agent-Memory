import net from "node:net";

export function isLoopbackHost(host) {
  const normalized = normalizeHost(host);
  if (!normalized) return false;
  if (normalized === "localhost" || normalized === "::1") return true;
  if (normalized.startsWith("::ffff:")) {
    return isLoopbackIpv4(normalized.slice("::ffff:".length));
  }
  if (net.isIPv4(normalized)) return isLoopbackIpv4(normalized);
  if (net.isIPv6(normalized)) return normalized === "::1";
  if (/^\d+$/.test(normalized)) return isLoopbackDecimalIpv4(normalized);
  return false;
}

function normalizeHost(host) {
  const trimmed = String(host || "").trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isLoopbackIpv4(value) {
  if (!net.isIPv4(value)) return false;
  return value.split(".")[0] === "127";
}

function isLoopbackDecimalIpv4(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffffffff) return false;
  return ((parsed >>> 24) & 0xff) === 127;
}
