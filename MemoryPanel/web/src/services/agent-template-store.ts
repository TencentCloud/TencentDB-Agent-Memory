/**
 * agent-template-store.ts — Agent 新建模板（本地 localStorage）。
 *
 * 从原 demoStore.ts 中抽出（独立职责：与 team/agent/task 本体无关，只服务
 * "新建 agent 时一键预填表单"这个辅助功能）。
 *
 * 模板分两类：
 *   - 内置模板（builtin=true）：随产品发布，不可删除，覆盖几种常见角色。
 *   - 自定义模板（builtin=false）：用户在新建弹窗里「保存为模板」生成，
 *     存 localStorage，可删。
 *
 * 后端上线后这层换成 GET/POST/DELETE /agent-templates 即可，UI 不用改。
 */

import i18n from '@/i18n';
import { emitChange, safeParse } from './storage-utils';

const AGENT_TEMPLATES_KEY = 'tdai-memory.agentTemplates.v1';

export interface AgentTemplate {
  template_id: string;
  /** 模板名（展示用，必填） */
  name: string;
  /** 模板说明（选填，给使用者看的一句话） */
  summary: string;
  /** 内置模板不可删除 */
  builtin: boolean;
  // ===== 预填到新建表单的字段（均为 agent 字段，不含 name —— name 由用户自己填）=====
  description: string;
  role_prompt: string;
  rules_prompt: string;
  skills: string[];
  code_graphs: string[];
  llm_wikis: string[];
  chat_memories: string[];
  created_at_ms: number;
}

/** 内置模板 —— 不落库，每次读取时与自定义模板合并返回。 */
function getBuiltinAgentTemplates(): AgentTemplate[] {
  return [
    {
      template_id: 'builtin-pr-reviewer',
      name: i18n.t('agentTemplate.builtin.prReviewer.name'),
      summary: i18n.t('agentTemplate.builtin.prReviewer.summary'),
      builtin: true,
      description: i18n.t('agentTemplate.builtin.prReviewer.description'),
      role_prompt: i18n.t('agentTemplate.builtin.prReviewer.rolePrompt'),
      rules_prompt: i18n.t('agentTemplate.builtin.prReviewer.rulesPrompt'),
      skills: [],
      code_graphs: [],
      llm_wikis: [],
      chat_memories: [],
      created_at_ms: 0,
    },
    {
      template_id: 'builtin-bugfix-engineer',
      name: i18n.t('agentTemplate.builtin.bugfixEngineer.name'),
      summary: i18n.t('agentTemplate.builtin.bugfixEngineer.summary'),
      builtin: true,
      description: i18n.t('agentTemplate.builtin.bugfixEngineer.description'),
      role_prompt: i18n.t('agentTemplate.builtin.bugfixEngineer.rolePrompt'),
      rules_prompt: i18n.t('agentTemplate.builtin.bugfixEngineer.rulesPrompt'),
      skills: [],
      code_graphs: [],
      llm_wikis: [],
      chat_memories: [],
      created_at_ms: 0,
    },
    {
      template_id: 'builtin-issue-triage',
      name: i18n.t('agentTemplate.builtin.issueTriage.name'),
      summary: i18n.t('agentTemplate.builtin.issueTriage.summary'),
      builtin: true,
      description: i18n.t('agentTemplate.builtin.issueTriage.description'),
      role_prompt: i18n.t('agentTemplate.builtin.issueTriage.rolePrompt'),
      rules_prompt: i18n.t('agentTemplate.builtin.issueTriage.rulesPrompt'),
      skills: [],
      code_graphs: [],
      llm_wikis: [],
      chat_memories: [],
      created_at_ms: 0,
    },
    {
      template_id: 'builtin-doc-engineer',
      name: i18n.t('agentTemplate.builtin.docEngineer.name'),
      summary: i18n.t('agentTemplate.builtin.docEngineer.summary'),
      builtin: true,
      description: i18n.t('agentTemplate.builtin.docEngineer.description'),
      role_prompt: i18n.t('agentTemplate.builtin.docEngineer.rolePrompt'),
      rules_prompt: i18n.t('agentTemplate.builtin.docEngineer.rulesPrompt'),
      skills: [],
      code_graphs: [],
      llm_wikis: [],
      chat_memories: [],
      created_at_ms: 0,
    },
  ];
}

function readCustomAgentTemplates(): AgentTemplate[] {
  if (typeof window === 'undefined') return [];
  return safeParse<AgentTemplate[]>(localStorage.getItem(AGENT_TEMPLATES_KEY), []);
}

function writeCustomAgentTemplates(templates: AgentTemplate[]): void {
  try {
    localStorage.setItem(AGENT_TEMPLATES_KEY, JSON.stringify(templates));
  } catch {
    /* ignore */
  }
  emitChange();
}

/** 读取全部模板（内置在前，自定义在后，按创建时间倒序）。 */
export function readAgentTemplates(): AgentTemplate[] {
  const custom = [...readCustomAgentTemplates()].sort((a, b) => b.created_at_ms - a.created_at_ms);
  return [...getBuiltinAgentTemplates(), ...custom];
}

/** 保存一个自定义模板（builtin 恒为 false）。 */
export function createAgentTemplate(input: {
  name: string;
  summary?: string;
  description?: string;
  role_prompt?: string;
  rules_prompt?: string;
  skills?: string[];
  code_graphs?: string[];
  llm_wikis?: string[];
  chat_memories?: string[];
}): AgentTemplate {
  const name = input.name.trim();
  if (!name) throw new Error(i18n.t('agentTemplate.error.nameRequired'));
  const now = Date.now();
  const tpl: AgentTemplate = {
    template_id: `tpl_${now}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    summary: (input.summary ?? '').trim(),
    builtin: false,
    description: (input.description ?? '').trim(),
    role_prompt: (input.role_prompt ?? '').trim(),
    rules_prompt: (input.rules_prompt ?? '').trim(),
    skills: input.skills ?? [],
    code_graphs: input.code_graphs ?? [],
    llm_wikis: input.llm_wikis ?? [],
    chat_memories: input.chat_memories ?? [],
    created_at_ms: now,
  };
  writeCustomAgentTemplates([...readCustomAgentTemplates(), tpl]);
  return tpl;
}

/** 删除一个自定义模板；内置模板不可删（静默忽略）。 */
export function deleteAgentTemplate(template_id: string): void {
  if (getBuiltinAgentTemplates().some((t) => t.template_id === template_id)) return;
  writeCustomAgentTemplates(readCustomAgentTemplates().filter((t) => t.template_id !== template_id));
}
