import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

import { renderKnowledgeToolsBlock } from "../../../src/injection/injectors/knowledge-tools-injector.js";
import { wrapAvailableSkillsBlock } from "../../../src/injection/injectors/skill-injector.js";
import { renderSkillToolsBlock } from "../../../src/injection/injectors/skill-tools-injector.js";
import { renderTdaiProfileMemoryBlock } from "../../../src/injection/injectors/tdai-profile-memory-injector.js";
import { renderTdaiMemoryToolsBlock } from "../../../src/injection/injectors/tdai-tools-injector.js";
import { FIXTURE, KNOWLEDGE_FIXTURES } from "./fixtures.js";
import type { EvalCase } from "./types.js";

type RendererModule = Record<string, (...args: any[]) => any> & { MEMORY_TOOLS_GUIDE?: string };
type PromptBlocks = Record<"memory_tools" | "memory_guide" | "skill_ro" | "available" | "knowledge", string>;

const manifest = JSON.parse(
  readFileSync(new URL("./baseline-manifest.json", import.meta.url), "utf8"),
) as { git_commit: string; blocks: Record<string, { sha256: string }> };

let baselinePromise: Promise<PromptBlocks> | undefined;

async function loadHistoricalModule(fileName: string): Promise<RendererModule> {
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const relative = `MemoryProxy/src/injection/injectors/${fileName}`;
  const source = execFileSync("git", ["show", `${manifest.git_commit}:${relative}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const bundled = await build({
    stdin: {
      contents: source,
      sourcefile: fileName,
      resolveDir: `${repoRoot}/MemoryProxy/src/injection/injectors`,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  const encoded = Buffer.from(bundled.outputFiles[0].text).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`) as Promise<RendererModule>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function baselineBlocks(): Promise<PromptBlocks> {
  baselinePromise ??= (async () => {
    const [memory, profile, skillTools, skills, knowledge] = await Promise.all([
      loadHistoricalModule("tdai-tools-injector.ts"),
      loadHistoricalModule("tdai-profile-memory-injector.ts"),
      loadHistoricalModule("skill-tools-injector.ts"),
      loadHistoricalModule("skill-injector.ts"),
      loadHistoricalModule("knowledge-tools-injector.ts"),
    ]);
    const blocks: PromptBlocks = {
      memory_tools: memory.renderTdaiMemoryToolsBlock(
        FIXTURE.proxyBaseUrl, FIXTURE.sessionId, FIXTURE.spaceId,
      ),
      memory_guide: profile.MEMORY_TOOLS_GUIDE ?? "",
      skill_ro: skillTools.renderSkillToolsBlock(
        FIXTURE.proxyBaseUrl, false, FIXTURE.sessionId, FIXTURE.spaceId,
      ),
      available: skills.wrapAvailableSkillsBlock(FIXTURE.listing),
      knowledge: knowledge.renderKnowledgeToolsBlock(KNOWLEDGE_FIXTURES, FIXTURE.spaceId, {
        sessionKey: FIXTURE.sessionId,
        userId: FIXTURE.userId,
        teamId: FIXTURE.teamId,
        agentId: FIXTURE.agentId,
      }),
    };
    for (const [name, value] of Object.entries(blocks)) {
      const expected = manifest.blocks[name]?.sha256;
      if (!expected || sha256(value) !== expected) {
        throw new Error(`Baseline block ${name} does not match baseline-manifest.json`);
      }
    }
    return blocks;
  })();
  return baselinePromise;
}

function candidateBlocks(): PromptBlocks {
  return {
    memory_tools: renderTdaiMemoryToolsBlock(
      FIXTURE.proxyBaseUrl, FIXTURE.sessionId, FIXTURE.spaceId,
    ),
    memory_guide: "",
    skill_ro: renderSkillToolsBlock(
      FIXTURE.proxyBaseUrl, false, FIXTURE.sessionId, FIXTURE.spaceId,
    ),
    available: wrapAvailableSkillsBlock(FIXTURE.listing),
    knowledge: renderKnowledgeToolsBlock(KNOWLEDGE_FIXTURES, FIXTURE.spaceId, {
      sessionKey: FIXTURE.sessionId,
      userId: FIXTURE.userId,
      teamId: FIXTURE.teamId,
      agentId: FIXTURE.agentId,
    }) ?? "",
  };
}

function caseContext(testCase: EvalCase): string {
  return [
    `<evaluation_context>\nworkspace_repo: ${testCase.workspace_repo ?? "acme/proxy"}`,
    ...(testCase.current_context ? [`current_context: ${testCase.current_context}`] : []),
    "</evaluation_context>",
  ].join("\n");
}

function profileBlock(testCase: EvalCase): string {
  if (!testCase.profile_memory) return "";
  return renderTdaiProfileMemoryBlock([{
    agentName: "Evaluation Agent",
    agentId: FIXTURE.agentId,
    isSelf: true,
    l3Content: testCase.profile_memory,
    l2Entries: [{ path: "projects/proxy.md", summary: "Proxy project decisions" }],
  }])?.content ?? "";
}

export async function renderEvalPrompt(
  variant: "baseline" | "candidate",
  testCase: EvalCase,
): Promise<{ prompt: string; blocks: PromptBlocks }> {
  const blocks = variant === "baseline" ? await baselineBlocks() : candidateBlocks();
  const profile = profileBlock(testCase);
  // Reproduce the original profile behavior: old profile output appended the
  // guide even when data was empty; Candidate emits data only and can be empty.
  const profileRegion = variant === "baseline"
    ? [profile, blocks.memory_guide].filter(Boolean).join("\n\n")
    : profile;
  return {
    prompt: [
      "You are in a controlled tool-routing evaluation. Follow the injected routing rules. Use Bash only when a cloud tool is required; never execute arbitrary shell commands.",
      blocks.skill_ro,
      blocks.available,
      blocks.knowledge,
      blocks.memory_tools,
      profileRegion,
      caseContext(testCase),
    ].filter(Boolean).join("\n\n"),
    blocks,
  };
}

export function promptHash(prompt: string): string {
  return sha256(prompt);
}
