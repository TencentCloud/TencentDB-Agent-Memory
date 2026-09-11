import { afterEach, describe, expect, it, vi } from "vitest";

import type { KnowledgeItem } from "../../../knowledge/core-client.js";
import { renderKnowledgeToolsBlock } from "../knowledge-tools-injector.js";
import { wrapAvailableSkillsBlock } from "../skill-injector.js";
import { renderSkillToolsBlock } from "../skill-tools-injector.js";
import { renderTdaiProfileMemoryBlock } from "../tdai-profile-memory-injector.js";
import { renderTdaiMemoryToolsBlock } from "../tdai-tools-injector.js";

afterEach(() => vi.unstubAllEnvs());

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

const knowledge: KnowledgeItem[] = [
  {
    knowledge_id: "kg-code",
    type: "code-graph",
    service_url: "https://knowledge.test/v3",
    name: "Proxy code graph",
    summary: "10 files",
    team_id: "team-1",
    user_id: null,
    repo_url: "git@example.test:acme/proxy.git",
    branch: "main",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
  {
    knowledge_id: "kg-wiki",
    type: "wiki",
    service_url: "https://knowledge.test/v3",
    name: "Architecture decisions",
    summary: "Design background and trade-offs",
    team_id: "team-1",
    user_id: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
];

describe("prompt renderer contracts", () => {
  it("renders the memory protocol once and keeps every read endpoint/body field", () => {
    const output = renderTdaiMemoryToolsBlock("https://proxy.test/", "session-1", "space-1");

    expect(occurrences(output, "<tdai_memory_tools>")).toBe(1);
    expect(occurrences(output, "</tdai_memory_tools>")).toBe(1);
    for (const path of [
      "/atomic/search",
      "/atomic/query",
      "/conversation/search",
      "/conversation/query",
      "/scenario/ls",
      "/scenario/read",
    ]) expect(output).toContain(path);
    for (const field of ["query", "limit", "offset", "session_id", "path_prefix", "agent_id"])
      expect(output).toContain(`\"${field}\"`);
    expect(output).toContain("x-tdai-service-id: space-1");
    expect(output).toContain("x-conversation-id: session-1");
    expect(output).toContain("明确缺口");
    expect(output).toContain("id 不是可调用的原生函数名");
    expect(output).toContain("<curl_recipe id=");
    expect(output).toContain("普通 coding");
    expect(output).toContain("用户特定历史、偏好");
    expect(output).toContain("skill_search 只找工作流，不能替代个性化检索");
    expect(output).toContain("时间顺序");
    expect(output).toContain("已知目标 session_id 可直接 query");
    expect(output).toContain("答案不依赖用户历史");
    expect(output).not.toContain("<memory-tools-guide>");
  });

  it("keeps skill read/write gating, paths, body fields and dynamic headers", () => {
    vi.stubEnv("SKILL_VIEW_MODE", "name");
    const readOnly = renderSkillToolsBlock("https://proxy.test", false, "session-1", "space-1");
    const writable = renderSkillToolsBlock("https://proxy.test", true, "session-1", "space-1");

    for (const tool of ["skill_search", "skill_view", "skill_files_read", "skill_extract"])
      expect(readOnly).toContain(`id=\"${tool}\"`);
    for (const tool of [
      "skill_create",
      "skill_update",
      "skill_patch",
      "skill_delete",
      "skill_files_write",
      "skill_files_remove",
    ]) {
      expect(readOnly).not.toContain(`id=\"${tool}\"`);
      expect(writable).toContain(`id=\"${tool}\"`);
    }
    for (const path of ["/search", "/get-by-name", "/files/read", "/extract"])
      expect(readOnly).toContain(path);
    for (const field of ["skill_name", "include_content", "include_manifest", "skill_id", "encoding"])
      expect(readOnly).toContain(`\"${field}\"`);
    expect(readOnly).toContain("x-tdai-service-id: space-1");
    expect(readOnly).toContain("x-conversation-id: session-1");
    expect(readOnly).toContain("列表已有明确匹配时不要搜索");
    expect(readOnly).toContain("不是原生函数名");
    expect(readOnly).toContain("<curl_recipe id=");
    expect(readOnly).toContain("完整说明不在上下文时");
    expect(readOnly).toContain("不能跳过 skill_view");
  });

  it("preserves upstream id lookup and physical deletion semantics", () => {
    vi.stubEnv("SKILL_VIEW_MODE", "id");
    const output = renderSkillToolsBlock("https://proxy.test", true);
    expect(output).toContain('path: https://proxy.test/skill-bridge/v3/skill/get\n');
    expect(output).not.toContain("/get-by-name");
    expect(output).toContain('<curl_recipe id="skill_view">');
    expect(output).toContain("skill_id 来自列表 id=");
    expect(output).toContain("物理删除 skill 全部版本");
    expect(output).not.toContain("软删");
    expect(output).not.toContain("<tool name=");
  });

  it("routes skill loading by clear workflow match instead of partial word overlap", () => {
    const listing = '<available_skills>\n- pdf: Work with PDF files\n</available_skills>';
    const output = wrapAvailableSkillsBlock(listing);

    expect(output).toContain(listing);
    expect(output).toContain("明确匹配");
    expect(output).toContain("仅词面相似");
    expect(output).toContain("即使任务表现为 coding、测试或 review");
    expect(output).toContain("不需要专项工作流且当前上下文足够");
    expect(output).not.toContain("partially relevant");
    expect(output).not.toContain("always better");
  });

  it("renders profile data only and returns null when profile data is empty", () => {
    expect(renderTdaiProfileMemoryBlock([])).toBeNull();
    expect(renderTdaiProfileMemoryBlock([{
      agentName: "Self",
      agentId: "agent-1",
      isSelf: true,
      l2Entries: [],
    }])).toBeNull();

    const rendered = renderTdaiProfileMemoryBlock([{
      agentName: "Self",
      agentId: "agent-1",
      isSelf: true,
      l3Content: "Prefers TypeScript",
      l2Entries: [{ path: "projects/proxy.md", summary: "Proxy decisions" }],
    }]);
    expect(rendered?.content).toContain("<tdai_profile_memory>");
    expect(rendered?.content).toContain("<l3_core_memory>");
    expect(rendered?.content).toContain("<l2_scene_index>");
    expect(rendered?.content).not.toContain("memory-tools-guide");
  });

  it("keeps knowledge resources, discovery protocol and auth headers", () => {
    const output = renderKnowledgeToolsBlock(knowledge, "space-1", {
      sessionKey: "session-1",
      userId: "user-1",
      teamId: "team-1",
      agentId: "agent-1",
    });

    expect(output).not.toBeNull();
    expect(occurrences(output!, "<knowledge_tools>")).toBe(1);
    expect(output).toContain('type="code-graph"');
    expect(output).toContain('match="acme/proxy"');
    expect(output).toContain('type="wiki"');
    expect(output).toContain('about="Design background and trade-offs"');
    expect(output).toContain("/tools/list");
    expect(output).toContain("/tools/call");
    expect(output).toContain("x-tdai-service-id: space-1");
    expect(output).toContain("x-conversation-id: session-1");
    expect(output).toContain("当前工作区的精确代码");
  });

  it("is byte-stable for identical inputs", () => {
    const render = () => [
      renderTdaiMemoryToolsBlock("https://proxy.test", "session-1", "space-1"),
      renderSkillToolsBlock("https://proxy.test", false, "session-1", "space-1"),
      wrapAvailableSkillsBlock("<available_skills />"),
      renderKnowledgeToolsBlock(knowledge, "space-1", { sessionKey: "session-1" }),
    ].join("\n");

    expect(Buffer.from(render())).toEqual(Buffer.from(render()));
  });
});
