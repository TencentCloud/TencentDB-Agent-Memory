/**
 * Measure the rendered size (chars + rough token estimate) of each static
 * injection block, for the prompt-injection optimization baseline.
 *
 * Token estimate heuristic: CJK chars ≈ 1 token each; ASCII ≈ 1 token / 4 chars.
 * (Close enough for before/after comparisons; real counts should use tiktoken
 * or the target model's tokenizer.)
 */
import { renderTdaiMemoryToolsBlock } from "../src/injection/injectors/tdai-tools-injector.js";
import { MEMORY_TOOLS_GUIDE } from "../src/injection/injectors/tdai-profile-memory-injector.js";
import { renderSkillToolsBlock } from "../src/injection/injectors/skill-tools-injector.js";
import { renderKnowledgeToolsBlock } from "../src/injection/injectors/knowledge-tools-injector.js";
import { wrapAvailableSkillsBlock } from "../src/injection/injectors/skill-injector.js";

function estimateTokens(text: string): number {
  let cjk = 0;
  let ascii = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk++;
    } else {
      ascii++;
    }
  }
  return Math.round(cjk + ascii / 4);
}

function report(name: string, text: string | null) {
  if (text === null) {
    console.log(`${name}: (null — not injected)`);
    return;
  }
  console.log(
    `${name}: chars=${text.length}  ~tokens=${estimateTokens(text)}  lines=${text.split("\n").length}`,
  );
}

const BASE = "http://127.0.0.1:8096";
const SID = "conv-abc123";
const SPACE = "mem-demo";

report("<tdai_memory_tools>", renderTdaiMemoryToolsBlock(BASE, SID, SPACE));
report("<memory-tools-guide>", MEMORY_TOOLS_GUIDE);
report("<skill_tools> (read-only)", renderSkillToolsBlock(BASE, false, SID, SPACE));
report("<skill_tools> (allow write)", renderSkillToolsBlock(BASE, true, SID, SPACE));

const fakeResources = [
  {
    knowledge_id: "kn-demo-1",
    type: "code-graph" as const,
    name: "TencentDB-Agent-Memory",
    service_url: "http://127.0.0.1:8421/v3",
    repo_url: "https://git.example.com/tdai/TencentDB-Agent-Memory.git",
    repo_slug: "tdai/TencentDB-Agent-Memory",
    branch: "main",
    summary: "1234 files, 5678 symbols",
  },
];
report(
  "<knowledge_tools> (1 resource)",
  renderKnowledgeToolsBlock(fakeResources, SPACE, {
    sessionKey: "codebuddy:conv-abc123",
    userId: "u1",
    teamId: "t1",
    agentId: "a1",
    agentSource: "codebuddy",
    spaceId: SPACE,
  }),
);

const fakeListing = "<available_skills>\n- commit: 提交代码\n- review-pr: 审查 PR\n</available_skills>";
report("<available_skills> wrapper (+2 skills)", wrapAvailableSkillsBlock(fakeListing));
