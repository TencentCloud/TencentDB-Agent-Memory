import { describe, expect, it } from "vitest";

import { sanitizeGitError, stripUserInfo } from "./sanitize.js";

describe("stripUserInfo", () => {
  it("抹掉 URL 里内嵌的 user:password", () => {
    expect(stripUserInfo("fatal: could not read from https://user:tok3n@git.example.com/o/r.git")).toBe(
      "fatal: could not read from https://***@git.example.com/o/r.git",
    );
  });

  it("抹掉只有 username 的写法（token 常被塞在 username 位）", () => {
    expect(stripUserInfo("https://ghp_secret@github.com/o/r.git")).toBe("https://***@github.com/o/r.git");
  });

  it("不动 scp-like 的 git@（那是协议语法，不是凭证）", () => {
    expect(stripUserInfo("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
  });

  it("一次替换多个出现", () => {
    const out = stripUserInfo("a https://u:p@h1/x b https://u:p@h2/y");
    expect(out).not.toContain("u:p@");
    expect(out.match(/\*\*\*@/g)).toHaveLength(2);
  });

  it("空串安全", () => {
    expect(stripUserInfo("")).toBe("");
  });
});

describe("sanitizeGitError", () => {
  it("按已知明文凭证做精确替换", () => {
    const token = "ghp_ABCDEFGHIJKLMNOP";
    const msg = `Authentication failed for 'https://git.example.com/o/r.git' using ${token}`;
    const out = sanitizeGitError(msg, [token]);
    expect(out).not.toContain(token);
    expect(out).toContain("***");
  });

  it("忽略过短的 secret（避免把正常文本打成筛子）", () => {
    const out = sanitizeGitError("a b c d e", ["a"]);
    expect(out).toBe("a b c d e");
  });

  it("默认截断到 500 字符", () => {
    const out = sanitizeGitError("x".repeat(900));
    expect(out).toHaveLength(500);
  });

  it("maxLength <= 0 表示不截断", () => {
    const out = sanitizeGitError("x".repeat(900), undefined, 0);
    expect(out).toHaveLength(900);
  });

  it("先脱敏再截断（脱敏不会被截断吃掉）", () => {
    const token = "ghp_ZZZZZZZZZZZZZZZZ";
    const msg = `${"a".repeat(600)} ${token}`;
    const out = sanitizeGitError(msg, [token]);
    expect(out).toHaveLength(500);
    expect(out).not.toContain(token);
  });
});
