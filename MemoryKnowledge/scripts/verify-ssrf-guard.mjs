#!/usr/bin/env node
/**
 * Repro + verification script for the SSRF guard hardening.
 *
 * Run (no dependencies required, Node >= 22 for native TS type stripping):
 *   node --experimental-strip-types MemoryKnowledge/scripts/verify-ssrf-guard.mjs
 *
 * It demonstrates, side by side:
 *   - the OLD check (a single regex over the raw host string) and how the
 *     listed bypass spellings sail through it;
 *   - the NEW ssrf-guard helpers, which classify every one of them correctly.
 *
 * This script is documentation/verification only. It is NOT part of the build
 * and imports only the dependency-free `ssrf-guard.ts` module.
 */

import {
  normalizeIPv4,
  isPrivateHostLiteral,
  resolveAndCheckHost,
} from "../src/source-fetcher/ssrf-guard.ts";

// The exact regex that was used before the fix (git-fetcher.ts @ 42d4cde).
const OLD_PRIVATE_ADDR_RE =
  /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|127\.|0\.|localhost$|::1$|fe80:)/i;
const oldCheck = (host) => OLD_PRIVATE_ADDR_RE.test(host);

// Hosts that all denote loopback / private space but are written differently.
// `expectedPrivate = true` for all of them.
const cases = [
  { host: "localhost", expectedPrivate: true },
  { host: "127.0.0.1", expectedPrivate: true },
  { host: "10.0.0.5", expectedPrivate: true },
  { host: "192.168.1.1", expectedPrivate: true },
  { host: "169.254.169.254", expectedPrivate: true, note: "cloud metadata" },
  { host: "2130706433", expectedPrivate: true, note: "integer form of 127.0.0.1" },
  { host: "0x7f000001", expectedPrivate: true, note: "hex form of 127.0.0.1" },
  { host: "0177.0.0.1", expectedPrivate: true, note: "octal form of 127.0.0.1" },
  { host: "::ffff:127.0.0.1", expectedPrivate: true, note: "IPv4-mapped IPv6" },
  { host: "::ffff:7f00:1", expectedPrivate: true, note: "mapped IPv6, hex tail" },
  { host: "::1", expectedPrivate: true },
  { host: "github.com", expectedPrivate: false, note: "control: public" },
  { host: "8.8.8.8", expectedPrivate: false, note: "control: public" },
];

const pad = (s, n) => String(s).padEnd(n);
let oldBypasses = 0;
let newCorrect = 0;

console.log("\nSSRF guard verification — OLD regex vs NEW helpers\n");
console.log(pad("HOST", 22) + pad("EXPECTED", 10) + pad("OLD", 10) + pad("NEW", 10) + "NOTE");
console.log("-".repeat(78));
for (const { host, expectedPrivate, note = "" } of cases) {
  const oldBlocked = oldCheck(host);
  const newBlocked = isPrivateHostLiteral(host);
  // OLD "blocks" iff it says private. A bypass = should block but OLD let it through.
  if (expectedPrivate && !oldBlocked) oldBypasses++;
  if (newBlocked === expectedPrivate) newCorrect++;
  console.log(
    pad(host, 22) +
      pad(expectedPrivate ? "private" : "public", 10) +
      pad(oldBlocked ? "BLOCK" : "PASS", 10) +
      pad(newBlocked ? "BLOCK" : "PASS", 10) +
      note,
  );
}

// DNS-based case: a hostname that resolves to a private address.
const fakeLookup = async (hostname) => {
  const map = { "internal.example.com": [{ address: "10.0.0.5", family: 4 }] };
  if (!map[hostname]) throw new Error("NXDOMAIN");
  return map[hostname];
};
const dnsResult = await resolveAndCheckHost("internal.example.com", fakeLookup);
console.log("-".repeat(78));
console.log(
  `DNS case: internal.example.com -> 10.0.0.5  |  OLD regex: PASS (no DNS lookup)  |  NEW: ${dnsResult.blocked ? "BLOCK" : "PASS"}`,
);

const ok = dnsResult.blocked;
console.log("\n" + "=".repeat(78));
console.log(`OLD regex bypassed ${oldBypasses} of ${cases.filter((c) => c.expectedPrivate).length} private hosts.`);
console.log(`NEW helpers classified ${newCorrect}/${cases.length} hosts correctly.`);
console.log(`NEW DNS check ${ok ? "blocked" : "FAILED TO BLOCK"} the private-resolving hostname.`);
console.log("=".repeat(78) + "\n");

process.exit(oldBypasses > 0 && newCorrect === cases.length && ok ? 0 : 1);
