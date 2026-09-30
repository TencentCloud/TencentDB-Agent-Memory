import test from "node:test";
import assert from "node:assert/strict";
import {
  containsCredential,
  hasNoMemoryDirective,
  inspectTurn,
  sanitizeText
} from "../src/privacy.mjs";

test("skip directive disables recall and capture", () => {
  assert.equal(inspectTurn("请回答[不记忆]", "答复").skip, true);
  assert.equal(inspectTurn("/nomemory 这轮不要保存", "答复").skip, true);
});

test("opt-out directives accept punctuation boundaries but not embedded words", () => {
  assert.equal(hasNoMemoryDirective("Please use /NoMemory for this turn"), true);
  assert.equal(hasNoMemoryDirective("/nomemory，别保存"), true);
  assert.equal(hasNoMemoryDirective("请用/nomemory。"), true);
  assert.equal(hasNoMemoryDirective("keep /nomemorynotes in the title"), false);
});

test("a detected credential skips the whole turn", () => {
  assert.equal(inspectTurn("API_KEY=" + "sk-" + "a".repeat(32), "答复").skip, true);
  assert.equal(inspectTurn("普通问题", "-----BEGIN PRIVATE KEY-----\nabc").skip, true);
});

test("credential detection recognizes bearer and common token prefixes", () => {
  assert.equal(containsCredential("Authorization: Bearer example-token-value"), true);
  assert.equal(containsCredential("The token is sk-" + "a".repeat(32)), true);
  assert.equal(containsCredential("token=ghp_" + "a".repeat(36)), true);
  assert.equal(containsCredential("github_pat_" + "a".repeat(22)), true);
  assert.equal(containsCredential("no secret is present"), false);
});

test("credential detection recognizes assigned English and Chinese secrets without matching prose", () => {
  for (const value of [
    "password=hunter2",
    "password : hunter2",
    "PASSWORD＝hunter2",
    "密码：hunter2",
    "密码 = hunter2",
    "token=plain-secret-value",
    "token ： plain-secret-value"
  ]) {
    assert.equal(containsCredential(value), true, value);
    assert.equal(inspectTurn(value, "ordinary reply").skip, true, value);
  }

  for (const value of [
    "The password policy requires twelve characters.",
    "Rotate the token after deployment.",
    "A password manager stores credentials.",
    "The token budget is 1000."
  ]) {
    assert.equal(containsCredential(value), false, value);
  }
});

test("credential detection recognizes quoted JSON-style assignments but ignores empty values", () => {
  for (const value of [
    '{"password":"hunter2"}',
    '{ "token" : "plain-secret-value" }',
    '{"api_key":"api-secret-value"}',
    '｛“密码”：“hunter2”｝',
    '「token」＝「plain-secret-value」',
    '＂password＂：＂hunter2＂'
  ]) {
    assert.equal(containsCredential(value), true, value);
    assert.equal(inspectTurn("ordinary prompt", value).skip, true, value);
  }

  for (const value of [
    '{"password":""}',
    '{ "token" : "   " }',
    '｛“密码”：“”｝',
    "token budget",
    "password policy",
    "密码管理"
  ]) {
    assert.equal(containsCredential(value), false, value);
  }
});

test("base64 media is removed without retaining the payload", () => {
  const result = inspectTurn("看图 data:image/png;base64," + "A".repeat(500), "完成");
  assert.equal(result.skip, false);
  assert.equal(result.user.includes("AAAA"), false);
  assert.match(result.user, /\[已移除多媒体数据\]/);
});

test("sanitizeText replaces long base64 runs and applies the per-side limit", () => {
  assert.equal(sanitizeText("prefix " + "A".repeat(400) + " suffix", 1000), "prefix [已移除多媒体数据] suffix");
  assert.equal(sanitizeText("x".repeat(10), 5), "xxxxx");
});

test("inspectTurn preserves sanitized content within user and assistant limits", () => {
  const result = inspectTurn("用".repeat(30_001), "答".repeat(60_001));
  assert.equal(result.skip, false);
  assert.equal(result.user.length, 30_000);
  assert.equal(result.assistant.length, 60_000);
});
