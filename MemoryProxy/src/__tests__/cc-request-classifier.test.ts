import { describe, it, expect } from "vitest";

import { classifyCcRequest, findLastCacheControlIndex } from "../common/cc-request-classifier.js";

/**
 * Gate del fix de clasificación main/fork (incidente 2026-08-28/29):
 *
 * Síntoma: TODAS las sesiones claude-code se clasificaban kind=fork a partir
 * de msgs>=3 → el proxy saltaba L0 write + skill buffer (proxy_kv = 0 filas).
 *
 * Causa raíz: la regla original "marker en n-2 → fork" asume que fork reutiliza
 * el caché del main dejando el marker en el penúltimo mensaje. Pero en el loop
 * agéntico REAL del main dialog, Claude Code coloca el breakpoint incremental
 * del prompt-caching sobre el último mensaje assistant (tool_use) que queda en
 * n-2 cuando el turno termina en un tool_result (user). Resultado: la sesión
 * main viva era "fork" en cada request agéntico → 0 writes L0.
 *
 * Fix: n-2 SOLO es fork si el mensaje marcado es role=user (los prompts internos
 * de fork — title/recap/compact — terminan en user). Si el mensaje marcado es
 * assistant, es el loop agéntico del main → MAIN.
 */

// Helpers ────────────────────────────────────────────────────────────────────

const block = (text: string, cache = false) =>
  cache ? { type: "text", text, cache_control: { type: "ephemeral" } } : { type: "text", text };

const user = (text: string, cache = false) => ({ role: "user", content: [block(text, cache)] });
const assistant = (text: string, cache = false) => ({ role: "assistant", content: [block(text, cache)] });

// tool_use del assistant / tool_result del user (el par del loop agéntico)
const toolUseAssistant = (cache = false) => ({
  role: "assistant",
  content: [
    cache
      ? { type: "tool_use", id: "tu1", name: "Bash", input: {}, cache_control: { type: "ephemeral" } }
      : { type: "tool_use", id: "tu1", name: "Bash", input: {} },
  ],
});
const toolResultUser = (cache = false) => ({
  role: "user",
  content: [
    cache
      ? { type: "tool_result", tool_use_id: "tu1", content: "ok", cache_control: { type: "ephemeral" } }
      : { type: "tool_result", tool_use_id: "tu1", content: "ok" },
  ],
});

// ── El caso real que motivó el fix (patrón de los logs del incidente) ───────

describe("incidente 2026-08-28: main agentic loop no es fork", () => {
  it("msgs=3: marker sobre assistant en n-2 → MAIN (antes clasificaba fork)", () => {
    const body = {
      model: "claude-x",
      tools: [{ name: "Bash" }],
      messages: [
        user("que hay krathos"),
        assistant("hola, te leo"),
        user("ok comitea con push", true), // marker n-1
      ],
    };
    // Con el fix: marker n-1 → main en todos los casos.
    expect(classifyCcRequest(body)).toBe("main");
  });

  it("msgs=5 (agentic): marker sobre assistant en n-2 → MAIN (caso central del bug)", () => {
    const body = {
      model: "claude-x",
      tools: [{ name: "Bash" }],
      messages: [
        user("que hay krathos"),
        assistant("hola"),
        user("revisa el estado"),
        toolUseAssistant(true), // marker sobre assistant/tool_use en n-2
        toolResultUser(),       // turno termina en tool_result (user)
      ],
    };
    expect(classifyCcRequest(body)).toBe("main");
  });

  it("msgs grande (msgs=89 del log real): marker assistant en n-2 → MAIN", () => {
    const msgs: unknown[] = [user("kickoff")];
    for (let i = 0; i < 43; i++) {
      msgs.push(assistant(`paso ${i}`));
      msgs.push(user(`ok paso ${i}`));
    }
    msgs.push(toolUseAssistant(true)); // n-2, marker
    msgs.push(toolResultUser());       // n-1
    expect(classifyCcRequest({ model: "m", tools: [{ name: "Bash" }], messages: msgs })).toBe("main");
  });

  it("marker sobre assistant en n-2 con tool_use → MAIN", () => {
    const body = {
      model: "m",
      tools: [{ name: "Bash" }],
      messages: [
        user("arranca"),
        assistant("antes de responder, ejecuto", true), // marker assistant n-2
        toolResultUser(),
      ],
    };
    expect(classifyCcRequest(body)).toBe("main");
  });
});

// ── Fork legítimo: NO debe romperse ─────────────────────────────────────────

describe("fork legitimo conserva clasificacion fork", () => {
  it("marker en n-2 sobre user (historia main + user final sin marker tras tool) → FORK", () => {
    // Fork real: reutiliza cache del main. La historia main termina con el
    // turno user del humano (marker del main quedó sobre ese user en la
    // historia heredada, ahora en n-2 del body del fork) y el fork añade su
    // prompt interno como user final SIN marker (skipCacheWrite=true).
    const body = {
      model: "m",
      tools: [],
      messages: [
        assistant("respuesta del dialogo principal"),
        user("pregunta del usuario", true), // marker heredado del main, ahora en n-2, role=user
        user("[TITLE MODE: genera un titulo corto]"), // prompt interno del fork, sin marker
      ],
    };
    expect(classifyCcRequest(body)).toBe("fork");
  });

  it("fork puro (una sola user marcada en n-2 + user final): FORK", () => {
    const body = {
      model: "m",
      tools: [],
      messages: [
        assistant("contexto previo"),
        user("[COMPACT: resume la conversacion]", true), // n-2 user marcado
        user("continua"),
      ],
    };
    expect(classifyCcRequest(body)).toBe("fork");
  });

  it("sin marker + tools vacios + thinking disabled → SIDEQUERY", () => {
    const body = {
      model: "m",
      tools: [],
      thinking: { type: "disabled" },
      messages: [user("title?")],
    };
    expect(classifyCcRequest(body)).toBe("sidequery");
  });
});

// ── Regresión: casos main clásicos ──────────────────────────────────────────

describe("regresion main clasico", () => {
  it("msgs=1 con marker en n-1 → MAIN", () => {
    expect(classifyCcRequest({ model: "m", messages: [user("hola", true)] })).toBe("main");
  });

  it("marker n-1 → MAIN", () => {
    const body = {
      model: "m",
      messages: [user("a"), assistant("b"), user("c", true)],
    };
    expect(classifyCcRequest(body)).toBe("main");
  });

  it("marker en posicion temprana (no n-1/n-2) → MAIN", () => {
    const body = {
      model: "m",
      messages: [user("a", true), assistant("b"), user("c")],
    };
    expect(classifyCcRequest(body)).toBe("main");
  });

  it("role system filtrado antes del conteo", () => {
    const body = {
      model: "m",
      messages: [
        { role: "system", content: "noop" },
        user("a", true),
      ],
    };
    expect(classifyCcRequest(body)).toBe("main");
  });

  it("mensaje sin content array (string content) no rompe", () => {
    const body = {
      model: "m",
      messages: [
        { role: "user", content: "texto plano" },
        { role: "assistant", content: "ok", cache_control: { type: "ephemeral" } }, // marker a nivel top-level no se ve
      ],
    };
    // Sin marker visible en content arrays → fallback main (tools presentes).
    expect(classifyCcRequest(body)).toBe("main");
  });

  it("marker role faltante → conservador fork (regla defensiva)", () => {
    const body = {
      model: "m",
      messages: [
        { role: "assistant", content: [block("ctx", true)] }, // marker n-2, sin role tras filter... tiene role
        { role: "user", content: [block("q")] },
      ],
    };
    // msgs = [assistant(marker), user] → n-2 es assistant → MAIN (no fork).
    // Este test documenta el cambio: antes era fork.
    expect(classifyCcRequest(body)).toBe("main");
  });
});

// ── Helper exportado (usado por langfuse-debug) ─────────────────────────────

describe("findLastCacheControlIndex", () => {
  it("encuentra el último marker", () => {
    const msgs = [user("a", true), assistant("b"), user("c", true)];
    expect(findLastCacheControlIndex(msgs)).toBe(2);
  });

  it("sin marker → -1", () => {
    expect(findLastCacheControlIndex([user("a"), assistant("b")])).toBe(-1);
  });
});
