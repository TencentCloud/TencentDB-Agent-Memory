import { describe, expect, it } from "vitest";
import { renderSkillToolsBlock } from "../injection/injectors/skill-tools-injector.js";
import { renderTdaiMemoryToolsBlock } from "../injection/injectors/tdai-tools-injector.js";

/**
 * 注入块里的 curl 配方必须是"跨 shell 可抄"的。
 *
 * 真机背景：Codex CLI 在 Windows 上把模型生成的 shell 命令交给 PowerShell 执行，
 * 而 `curl` 在 PowerShell 里是 `Invoke-WebRequest` 的别名 —— 它不接受 `-H 'k: v'`
 * 这种写法（报「无法绑定参数 Headers」/「Cannot bind parameter 'Headers'」，类型
 * System.String → System.Collections.IDictionary），也不认 `-d`。
 * 结果是模型照抄配方、连试两次后放弃，整段 skill / 记忆调用失效。
 * 所以两个配方块都必须写明 Windows 下用 `curl.exe`。
 */
describe("注入块的 curl 配方跨 shell 可用", () => {
  const blocks: Array<[string, string]> = [
    ["skill_tools", renderSkillToolsBlock("http://127.0.0.1:8096", true, "sid-x", "default")],
    ["tdai_memory_tools", renderTdaiMemoryToolsBlock("http://127.0.0.1:8096", "sid-x", "default")],
  ];

  it.each(blocks)("%s 块点明 Windows 下必须写 curl.exe", (_name, text) => {
    expect(text).toContain("curl.exe");
    expect(text).toMatch(/PowerShell/);
  });

  it.each(blocks)("%s 块给出别名报错的特征串，便于模型自行纠正", (_name, text) => {
    expect(text).toMatch(/无法绑定参数 Headers/);
  });

  it("基础配方本身保持不变（仍是 curl + -H 'k: v'）", () => {
    const text = renderSkillToolsBlock("http://127.0.0.1:8096", true, "sid-x", "default");
    expect(text).toContain("curl -sSk -X POST");
    expect(text).toContain("-H 'x-conversation-id: sid-x'");
  });
});
