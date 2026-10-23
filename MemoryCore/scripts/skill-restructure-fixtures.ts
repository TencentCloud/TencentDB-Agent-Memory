import { createHash } from "node:crypto";
import type { ReviewedSkillRestructureResult, SkillPackageSnapshot, SkillResourcePayload } from "../src/core/skill/restructure/types.js";

export interface SkillRestructureFixture {
  name: string;
  snapshot: SkillPackageSnapshot;
  baselineSnapshot?: SkillPackageSnapshot;
  expectedRules: string[];
  check(result: ReviewedSkillRestructureResult): string[];
}

const probe: SkillResourcePayload = { path: "scripts/probe.sql", content: "-- Read-only connectivity probe.\nSELECT 1;\n", encoding: "utf-8", mime_type: "text/plain", is_executable: false };
const image: SkillResourcePayload = { path: "assets/topology.png", content: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).toString("base64"), encoding: "base64", mime_type: "image/png", is_executable: false };
const bytes = (r: SkillResourcePayload) => Buffer.from(r.content, r.encoding === "base64" ? "base64" : "utf-8");
function snapshot(name: string, body: string, resources: SkillResourcePayload[]): SkillPackageSnapshot {
  return {
    skill_id: "skl-fixture-source", version: 4, name,
    content: `---\nname: ${name}\ndescription: Use when diagnosing service operations.\nsource: auto\n---\n\n${body}`,
    identity: { user_id: "fixture-user", team_id: "fixture-team", agent_id: "fixture-agent" }, metadata: { purpose: "synthetic-evaluation" },
    manifest: resources.map(r => ({ path: r.path, size_bytes: bytes(r).length, mime_type: r.mime_type!, is_executable: r.is_executable! })),
    resources,
  };
}
function finalText(result: ReviewedSkillRestructureResult): string {
  if (result.kind === "keep") return "";
  return [result.root, ...result.children].flatMap(p => [p.content, ...p.resources.filter(r => r.encoding === "utf-8" || r.mime_type?.startsWith("text/")).map(r => bytes(r).toString("utf-8"))]).join("\n");
}
function resourcePreserved(result: ReviewedSkillRestructureResult, source: SkillResourcePayload): boolean {
  if (result.kind === "keep") return true;
  const digest = createHash("sha256").update(bytes(source)).digest("hex");
  return [result.root, ...result.children].some(p => p.resources.some(r => createHash("sha256").update(bytes(r)).digest("hex") === digest && r.is_executable === source.is_executable));
}

const coreRules = `## Scope and safeguards
Diagnose MySQL connection failures. Do not change production configuration or restart a production service without explicit operator approval.
Never put passwords or access tokens in diagnostic logs.
Keep the connection timeout at 5000 ms for the diagnostic probe; do not silently increase it to hide a failure.

## Main workflow
Check DNS resolution, then TCP reachability, then TLS negotiation, then authentication, then connection-pool saturation.
Capture read-only evidence before proposing any change. Use [the read-only probe](scripts/probe.sql).
Validate recovery with the same probe and report which layer failed, evidence, proposed change, and verification result.
Topology is available in [the diagram](assets/topology.png).
`;
const eventDiary = Array.from({ length: 160 }, (_, i) => `
### Incident record ${i + 1}
On a previous support shift, a customer reported that the application could not connect. The engineer opened ticket CASE-${1000 + i}, copied the dashboard chart, repeated the DNS/TCP/TLS/authentication/pool checks, then wrote a long handover note. The diagnostic result was useful; the ticket number, shift chronology and copied conversation were not reusable instructions. The same read-only evidence must be captured before proposing a change, and operator approval is required before production changes.
${i === 117 ? "For a certificate validation failure, NEVER disable TLS certificate verification. Fix the trust chain or certificate with operator approval instead.\n" : ""}`).join("");

const connection = snapshot("mysql-connection-diagnostics", coreRules + "\n## Repeated support history\n" + eventDiary, [probe, image]);
const mixed = snapshot("service-operating-guide", coreRules + `
## Separate frontend accessibility workflow
Use this capability when reviewing a web page for keyboard and screen-reader access; it is not a MySQL connection diagnostic.
Navigate every interactive control using only the keyboard. Confirm a visible focus indicator and a logical focus order.
Check that form controls have accessible names and that validation errors are announced to screen readers.
Measure text contrast against WCAG AA requirements, and report the exact failing elements with reproduction steps.
Do not claim accessibility compliance solely from an automated scanner; manually verify keyboard navigation and screen-reader announcements.
` + eventDiary, [probe, image]);
const coherent = snapshot("read-only-mysql-probe", `## When to use
Use this skill only to verify MySQL connectivity with a read-only probe.

## Safety
Never change production settings or log credentials. Stop and request operator approval if remediation would require a write.

## Workflow
Run the [read-only probe](scripts/probe.sql), record success or the exact error, and report the result. Do not guess that a failed connection means the database is down.
The large [topology asset](assets/topology.png) is reference material; load it only if needed.
`, [probe, { ...image, content: Buffer.alloc(1_100_000, 66).toString("base64") }]);
coherent.content = coherent.content.replace("description: Use when diagnosing service operations.", "description: Use when verifying MySQL connectivity with a read-only probe, without changing production settings.");
const healthProcedure = `## Read-only HTTPS health procedure
Use when an operator asks to check an explicitly supplied HTTPS health endpoint. Python 3.9+ with its standard library is available; do not add third-party dependencies.
Never change production configuration, restart services, disable TLS certificate verification, or automatically retry a failed probe. Never log credentials, request headers or response bodies. Reject URLs containing userinfo, query parameters or fragments before any request.
Perform exactly one GET using the normal system TLS trust store and a fixed 5-second timeout. Buffer at most 65536 payload bytes; one extra overflow-detection byte may be read, and larger responses must be rejected. Accept only HTTP 200 with a JSON object whose ready field is the Boolean true. HTTP errors, transport/TLS errors, malformed JSON, missing ready and ready=false are failures, not proof that a database is down.
Use exit code 0 for ready, 1 for probe failure and 2 for invalid input. Output only a short safe status summary; do not echo the URL or exception text, which can contain sensitive information. TLS trust may be configured through the standard SSL_CERT_FILE environment variable, never by disabling verification.
This procedure is repeated frequently. Preserve these rules in a reusable executable Python script rather than making each operator reconstruct the algorithm. Keep its invocation and always-on safeguards in the skill entry point.

## Report skeleton
The reusable Markdown report has these fields: Target hostname, Observation time (UTC), HTTP status, Readiness, Evidence, Proposed action, Approval status, Verification result, Limitations. Unknown values must be labelled unknown, never invented. Capture read-only evidence first; any remediation requiring a production write needs explicit operator approval. Recheck recovery with the identical probe.

## Interpretation reference
A 200 response with ready=false can indicate warmup; it does not establish a database outage. A certificate error needs approved trust/certificate investigation, not a verification bypass. A non-JSON response may come from a proxy/login page: report the category without pasting the body or authenticating automatically. HTTP 429 is a service response, not permission to retry in a loop.
`;
const health = snapshot("https-health-diagnostics", healthProcedure + Array.from({ length: 120 }, (_, i) => `\n### Shift ${i + 1}\nThe operator repeated the same HTTPS GET procedure, checked the same readiness flag and filled the same report fields. They opened a shift ticket, pasted an old checklist, checked the 5-second timeout and verified that no production writes or retries were performed. These shift details do not add a new capability.\n`).join(""), []);

export const SKILL_RESTRUCTURE_FIXTURES: SkillRestructureFixture[] = [
  {
    name: "duplicate-history", snapshot: connection,
    expectedRules: ["Production changes and restarts require explicit operator approval.", "Credentials must not enter logs.", "Diagnostic timeout remains 5000 ms.", "DNS → TCP → TLS → authentication → pool checks remain ordered.", "TLS certificate verification must never be disabled.", "Read-only probe and binary topology bytes survive."],
    check(result) {
      const issues: string[] = [];
      if (result.kind !== "restructured") return ["An obviously repetitive history was not restructured."];
      if (result.children.length !== 0) issues.push("A single diagnostic capability was fragmented into children.");
      const text = finalText(result);
      if (text.length >= connection.content.length / 2) issues.push("Repeated narrative was not substantially distilled.");
      if (!/5000/.test(text)) issues.push("The fixed diagnostic timeout disappeared.");
      if (!/certificate/i.test(text)) issues.push("Certificate-validation safeguard disappeared.");
      for (const source of [probe, image]) if (!resourcePreserved(result, source)) issues.push(`Original resource bytes/attributes changed: ${source.path}`);
      return issues;
    },
  },
  {
    name: "independent-capabilities", snapshot: mixed,
    expectedRules: ["Keep MySQL diagnostics distinct from web accessibility auditing.", "Child capabilities are independently triggerable and self-contained.", "Keyboard focus, accessible names, announced validation errors and WCAG AA contrast all remain.", "An automated scanner alone does not establish accessibility compliance.", "Production-change approval, credential safety and the 5000 ms diagnostic timeout remain."],
    check(result) {
      if (result.kind !== "restructured") return ["Mixed independent capabilities were not reorganized."];
      const issues: string[] = [];
      if (!result.children.length) issues.push("No independent capability was extracted.");
      const text = finalText(result);
      if (!/keyboard/i.test(text) || !/screen.reader/i.test(text) || !/contrast/i.test(text) || !/5000/.test(text)) issues.push("A diagnostic/accessibility task requirement disappeared.");
      for (const source of [probe, image]) if (!resourcePreserved(result, source)) issues.push(`Resource changed: ${source.path}`);
      return issues;
    },
  },
  {
    name: "repeatable-health-workflow", snapshot: health,
    expectedRules: ["One HTTPS GET, normal TLS verification, no production writes/restarts/retries.", "Reject URL credentials, query parameters and fragments before networking.", "Fixed 5-second timeout, 65536-byte response limit, and only HTTP200 + ready=true succeeds.", "Reusable executable standard-library Python probe and report skeleton; no sensitive output or guessed results."],
    check(result) {
      if (result.kind !== "restructured") return ["The repetitive operational procedure was not consolidated."];
      const issues: string[] = [];
      if (result.children.length) issues.push("One health-check capability was unnecessarily fragmented.");
      if (!result.root.resources.some(resource => resource.path.startsWith("scripts/") && resource.path.endsWith(".py") && resource.is_executable)) issues.push("No reusable executable Python probe was produced.");
      if (!result.root.resources.some(resource => resource.path.startsWith("templates/"))) issues.push("The repeated report skeleton was not made reusable as a template.");
      return issues;
    },
  },
  {
    name: "candidate-rule-loss",
    snapshot: snapshot("mysql-connection-diagnostics", coreRules, [probe, image]),
    baselineSnapshot: connection,
    expectedRules: ["A shortened candidate cannot hide the original package from review.", "Restore the prior prohibition on disabling TLS certificate verification.", "Preserve the 5000 ms timeout, approval requirement, probe and binary bytes."],
    check(result) {
      if (result.kind !== "restructured") return ["A candidate missing the original TLS safeguard was accepted unchanged."];
      const issues: string[] = [];
      const text = finalText(result);
      if (!/(?:never|do not|must not).{0,60}disable.{0,60}(?:TLS|certificate).{0,60}verification/is.test(text)) issues.push("The original certificate-verification prohibition was not restored.");
      if (!/5000/.test(text)) issues.push("The diagnostic timeout disappeared.");
      if (result.children.length) issues.push("A single diagnostic capability was unnecessarily split.");
      for (const source of [probe, image]) if (!resourcePreserved(result, source)) issues.push(`Resource changed: ${source.path}`);
      return issues;
    },
  },
  {
    name: "binary-heavy-coherent", snapshot: coherent,
    expectedRules: ["Binary size alone must not force semantic rewriting or independent skill creation.", "The small coherent workflow and original resources remain unchanged."],
    check(result) { return result.kind === "keep" ? [] : ["A coherent skill was rewritten solely because its binary attachment was large."]; },
  },
];
