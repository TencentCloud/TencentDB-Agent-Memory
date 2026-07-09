import assert from "node:assert/strict";
import test from "node:test";

import { inspectTextBuffer, isTextPath } from "./check-text-encoding.mjs";

const utf8 = (value) => Buffer.from(value, "utf8");

test("accepts intentional multilingual UTF-8", () => {
  const findings = inspectTextBuffer(utf8("中文，日本語, café — arrows → and emoji 🚀\n"));
  assert.deepEqual(findings, []);
});

test("reports Windows-1252 mojibake at its source position", () => {
  const findings = inspectTextBuffer(utf8("first line\nbroken \u00e2\u20ac\u201d punctuation\n"), "sample.md");
  assert.equal(findings.length, 1);
  assert.deepEqual(
    { kind: findings[0].kind, line: findings[0].line, column: findings[0].column },
    { kind: "mojibake", line: 2, column: 8 },
  );
});

test("reports common Chinese-code-page mojibake", () => {
  const findings = inspectTextBuffer(utf8("L0\u922b\u62611 and \u9225?quoted"), "sample.ts");
  assert.equal(findings.length, 2);
  assert.ok(findings.every((finding) => finding.kind === "mojibake"));
});

test("rejects malformed UTF-8 bytes", () => {
  const findings = inspectTextBuffer(Buffer.from([0x66, 0x6f, 0x80]), "bad.py");
  assert.equal(findings[0].kind, "invalid-utf8");
});

test("reports replacement characters left by a lossy decode", () => {
  const findings = inspectTextBuffer(utf8("already replaced: \uFFFD"), "lossy.md");
  assert.equal(findings[0].kind, "replacement-character");
});

test("accepts an explicit UTF-8 BOM", () => {
  const findings = inspectTextBuffer(Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    utf8("PowerShell UTF-8 BOM — 中文\n"),
  ]), "harden.ps1");
  assert.deepEqual(findings, []);
});

test("requires UTF-8 BOM for PowerShell scripts", () => {
  const findings = inspectTextBuffer(utf8("Write-Host '中文 — ok'\n"), "scripts/harden.ps1");
  assert.equal(findings[0].kind, "missing-utf8-bom");
});

test("limits repository scanning to known text formats", () => {
  assert.equal(isTextPath("src/index.ts"), true);
  assert.equal(isTextPath(".gitattributes"), true);
  assert.equal(isTextPath("assets/logo.png"), false);
});
