/**
 * Pin test — AGENT_PREFIX_RE MUST be derived from AGENT_SOURCE_PREFIXES.
 *
 * Ronda 2026-09-09 (qwen hallazgo 1 / opencode hallazgo 3): la lista de
 * fuentes se duplicó a mano en regex y array y ya había divergido dos veces
 * (pi/#1195, opencode/40101 en lectura viva). Hoy la regex se construye desde
 * el array; este test fija el comportamiento por fuente para que cualquier
 * reintroducción de un literal paralelo divergente falle aquí.
 */

import { describe, expect, it } from "vitest";

import { AGENT_SOURCE_PREFIXES, matchWhitelistEndpoint, normalizeWhitelistRequestPath } from "../whitelist.js";

describe("AGENT_SOURCE_PREFIXES ↔ route regex coupling", () => {
  it("routes every known agent source through whitelist normalization", () => {
    for (const source of AGENT_SOURCE_PREFIXES) {
      expect(
        normalizeWhitelistRequestPath(`/${source}/space-x/v1/messages`),
        `ruta de fuente ${source}`,
      ).toBe("/v1/messages");
    }
  });

  it("unknown source does not normalize as an agent prefix", () => {
    expect(normalizeWhitelistRequestPath("/no-existe/space-x/v1/messages")).toBe(
      "/no-existe/space-x/v1/messages",
    );
  });

  it("matching stays case-insensitive (regex /i preserved by the derivation)", () => {
    expect(normalizeWhitelistRequestPath("/OpenCode/space-x/v1/messages")).toBe(
      "/v1/messages",
    );
  });

  it("whitelist endpoint matching works for every source", () => {
    for (const source of AGENT_SOURCE_PREFIXES) {
      expect(
        matchWhitelistEndpoint(`/${source}/space-x/v1/messages`),
        `whitelist de fuente ${source}`,
      ).toBeDefined();
    }
  });
});
