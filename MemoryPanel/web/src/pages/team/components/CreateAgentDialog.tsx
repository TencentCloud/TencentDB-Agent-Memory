/**
 * CreateAgentDialog —— 创建 Agent 弹窗（拆自 TeamManagementPanel）。
 * 支持套用/保存模板、勾选 skills/code_graph/llm_wiki/chat_memory 原子能力。
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Modal, Tag } from 'tea-component';
import {
  AddIcon,
  StarFilledIcon,
  CloseIcon,
  BooksIcon,
  CodeIcon,
  ToolsIcon,
  ChatIcon,
} from 'tea-icons-react';
import {
  readAgentTemplates,
  createAgentTemplate,
  deleteAgentTemplate,
  type AgentTemplate,
} from '@/services';

import type { AgentCard } from './types';
import { useTeamAssets } from './useAgentAssets';
import { LightField, CollapseGroup, AssetCheckList } from './shared';

export default function CreateAgentDialog({
  team,
  currentUser: _currentUser,
  onClose,
  onCreated,
  busy,
}: {
  team: { team_id: string; name: string };
  currentUser: string;
  onClose: () => void;
  onCreated: (card: Omit<AgentCard, 'id' | 'icon' | 'accent'>) => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rolePrompt, setRolePrompt] = useState('');
  const [rulesPrompt, setRulesPrompt] = useState('');
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [codeGraphOpen, setCodeGraphOpen] = useState(false);
  const [wikiOpen, setWikiOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [skills, setSkills] = useState<string[]>([]);
  const [codeGraphs, setCodeGraphs] = useState<string[]>([]);
  const [llmWikis, setLlmWikis] = useState<string[]>([]);
  const [chatMemories, setChatMemories] = useState<string[]>([]);

  const [templates, setTemplates] = useState<AgentTemplate[]>(() => readAgentTemplates());
  const [appliedTemplateId, setAppliedTemplateId] = useState<string>('');
  const [saveTplOpen, setSaveTplOpen] = useState(false);
  const [tplName, setTplName] = useState('');
  const [tplSummary, setTplSummary] = useState('');
  // 保存模板表单里可编辑的 agent 内容字段：默认取自当前主表单，
  // 展开保存表单时预填，用户可微调后再存入模板（不含 agent 名字）。
  const [tplDescription, setTplDescription] = useState('');
  const [tplRolePrompt, setTplRolePrompt] = useState('');
  const [tplRulesPrompt, setTplRulesPrompt] = useState('');

  // 从真实 API 拉取团队资产列表
  const assets = useTeamAssets(team.team_id);

  const canSubmit = name.trim().length > 0 && !busy;
  const totalSelected = skills.length + codeGraphs.length + llmWikis.length + chatMemories.length;

  function toggle(list: string[], setList: (v: string[]) => void, key: string) {
    setList(list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);
  }

  function applyTemplate(tpl: AgentTemplate) {
    // 模板只承载文本描述，套用时不改动用户已勾选的原子能力。
    setDescription(tpl.description);
    setRolePrompt(tpl.role_prompt);
    setRulesPrompt(tpl.rules_prompt);
    setAppliedTemplateId(tpl.template_id);
  }

  // 展开「保存为模板」表单时，用当前主表单值预填可编辑字段。
  function openSaveTemplateForm() {
    setSaveTplOpen((v) => {
      const next = !v;
      if (next) {
        setTplDescription(description);
        setTplRolePrompt(rolePrompt);
        setTplRulesPrompt(rulesPrompt);
      }
      return next;
    });
  }

  // 关闭并清空保存模板表单的全部字段。
  function resetSaveTemplateForm() {
    setSaveTplOpen(false);
    setTplName('');
    setTplSummary('');
    setTplDescription('');
    setTplRolePrompt('');
    setTplRulesPrompt('');
  }

  function handleSaveTemplate() {
    const nm = tplName.trim();
    if (!nm) return;
    // 模板只保存文本描述，不保存所选原子能力（skills / code_graph / llm_wiki / chat_memory）。
    createAgentTemplate({
      name: nm,
      summary: tplSummary.trim(),
      description: tplDescription.trim(),
      role_prompt: tplRolePrompt.trim(),
      rules_prompt: tplRulesPrompt.trim(),
    });
    setTemplates(readAgentTemplates());
    resetSaveTemplateForm();
  }

  function handleDeleteTemplate(tpl: AgentTemplate) {
    if (tpl.builtin) return;
    deleteAgentTemplate(tpl.template_id);
    setTemplates(readAgentTemplates());
    if (appliedTemplateId === tpl.template_id) setAppliedTemplateId('');
  }

  return (
    <Modal visible caption={t('team.agents.createAgent', { defaultValue: '创建 Agent' })} size="l" onClose={onClose} disableEscape={busy}>
      <Modal.Body>
        <div className="_memory-form-stack">
          <div className="_memory-modal-description">只有名字必填 · 描述 / 规则 prompt / 原子能力都可留空，创建后再补</div>
        <div className="_memory-target-team-row">
          <span className="_memory-target-team-avatar">{team.name.slice(0, 1).toUpperCase()}</span>
          <div className="_memory-target-team-meta">
            <div className="_memory-target-team-label">将创建到 team</div>
            <div className="_memory-target-team-name-row">
              <span className="_memory-target-team-name">{team.name}</span>
              <Tag size="sm">{team.team_id}</Tag>
            </div>
          </div>
          <div className="_memory-target-team-hint">
            切 team 请到
            <br />
            左上角
          </div>
        </div>

        <div className="_memory-template-box">
          <div className="_memory-template-box-title-row">
            <span className="_memory-template-box-title">套用模板</span>
            <span className="_memory-template-box-hint">
              选填 · 一键预填描述 / prompt / 原子能力，名字仍需自己填
            </span>
          </div>
          <div className="_memory-template-chip-row">
            {templates.map((tpl) => {
              const active = appliedTemplateId === tpl.template_id;
              return (
                <span
                  key={tpl.template_id}
                  className={`_memory-template-chip${active ? ' _memory-template-chip--active' : ''}`}
                >
                  <button
                    type="button"
                    onClick={() => applyTemplate(tpl)}
                    title={tpl.summary || tpl.name}
                    className="_memory-template-chip-btn"
                  >
                    {tpl.builtin && <StarFilledIcon size={11} />} {tpl.name}
                  </button>
                  {!tpl.builtin && (
                    <button
                      type="button"
                      onClick={() => handleDeleteTemplate(tpl)}
                      title="删除该自定义模板"
                      className="_memory-template-chip-close"
                      aria-label="删除该自定义模板"
                    >
                      <CloseIcon size={10} />
                    </button>
                  )}
                </span>
              );
            })}
            <button
              type="button"
              onClick={openSaveTemplateForm}
              className="_memory-template-save-btn"
            >
              <AddIcon size={11} /> 保存为模板
            </button>
          </div>
          {saveTplOpen && (
            <div className="_memory-template-save-form">
              <div className="_memory-template-save-hint">
                把当前表单存成可复用的自定义模板（数据存储在浏览器本地，清除缓存会丢失已保存的模板）。以下内容默认取自当前表单，可在此微调。
              </div>
              <Input
                size="full"
                value={tplName}
                onChange={setTplName}
                placeholder="模板名（必填），如：安全审计 Reviewer"
              />
              <Input
                size="full"
                value={tplSummary}
                onChange={setTplSummary}
                placeholder="一句话说明（选填）"
              />
              <div className="_memory-light-field-label">一句话描述</div>
              <Input
                size="full"
                value={tplDescription}
                onChange={setTplDescription}
                placeholder="模板的一句话功能介绍（选填）"
              />
              <div className="_memory-light-field-label">角色定位 prompt</div>
              <Input.TextArea
                size="full"
                rows={3}
                value={tplRolePrompt}
                onChange={setTplRolePrompt}
                placeholder="role prompt · 这个 agent 扮演什么角色 / 职责定位（选填）"
              />
              <div className="_memory-light-field-label">规则固定 prompt</div>
              <Input.TextArea
                size="full"
                rows={4}
                value={tplRulesPrompt}
                onChange={setTplRulesPrompt}
                placeholder={'rules prompt · 硬约束，建议编号列表（选填）\n1. …\n2. …'}
                className="_memory-mono-textarea"
              />

              <div className="_memory-template-save-actions">
                <Button onClick={resetSaveTemplateForm}>取消</Button>
                <Button type="primary"
                  disabled={!tplName.trim()}
                  onClick={handleSaveTemplate}
                >
                  保存模板
                </Button>
              </div>
            </div>
          )}
        </div>

        <LightField label="名字 *">
          <Input
            autoFocus
            size="full"
            value={name}
            onChange={setName}
            placeholder="如 Code Reviewer"
          />
          <div className="_memory-field-hint">
            agent_id 由后端生成并保证全局唯一（不限于本 team）。
          </div>
        </LightField>

        <LightField label="一句话描述" hint="选填 · 留空也可以，详情页随时改。">
          <Input
            size="full"
            value={description}
            onChange={setDescription}
            placeholder="一句话功能介绍：这个 agent 是干什么的？（选填）"
          />
        </LightField>

        <LightField
          label="角色定位 prompt"
          hint="role prompt · 选填 · 描述这个 agent 扮演什么角色 / 职责定位，创建后可在详情页补。"
        >
          <Input.TextArea
            size="full"
            value={rolePrompt}
            onChange={setRolePrompt}
            rows={3}
            placeholder="如：你是严格的 PR Reviewer，是代码合入主干前的最后一道质量关卡。"
          />
        </LightField>

        <LightField
          label="规则固定 prompt"
          hint="rules prompt · 选填 · 注入到每次对话开头的硬约束，建议用编号列表，创建后可在详情页补。"
        >
          <Input.TextArea
            size="full"
            value={rulesPrompt}
            onChange={setRulesPrompt}
            rows={4}
            placeholder={'1. …\n2. …\n3. …'}
            className="_memory-mono-textarea"
          />
        </LightField>

        {assets.loading ? (
          <div className="_memory-asset-loading">加载团队资产中…</div>
        ) : (
          <>
            <div className="_memory-asset-toolbar">
              <span className="_memory-asset-toolbar-label">原子能力：</span>
              <button
                type="button"
                onClick={() => {
                  setSkills(assets.skills.map((a) => a.key));
                  setCodeGraphs(assets.codeGraphs.map((a) => a.key));
                  setLlmWikis(assets.wikis.map((a) => a.key));
                  setChatMemories(assets.chatMemories.map((a) => a.key));
                }}
                className="_memory-asset-toolbar-btn"
              >
                一键全选
              </button>
              {totalSelected > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setSkills([]);
                    setCodeGraphs([]);
                    setLlmWikis([]);
                    setChatMemories([]);
                  }}
                  className="_memory-asset-toolbar-btn"
                >
                  清空
                </button>
              )}
            </div>
            <CollapseGroup
              icon={<BooksIcon size={16} />}
              title="Wiki 知识库"
              selectedCount={llmWikis.length}
              totalCount={assets.wikis.length}
              open={wikiOpen}
              onToggle={() => setWikiOpen(!wikiOpen)}
            >
              <AssetCheckList
                assets={assets.wikis}
                checkedKeys={llmWikis}
                onToggle={(k) => toggle(llmWikis, setLlmWikis, k)}
              />
            </CollapseGroup>
            <CollapseGroup
              icon={<CodeIcon size={16} />}
              title="Code_Graph"
              selectedCount={codeGraphs.length}
              totalCount={assets.codeGraphs.length}
              open={codeGraphOpen}
              onToggle={() => setCodeGraphOpen(!codeGraphOpen)}
            >
              <AssetCheckList
                assets={assets.codeGraphs}
                checkedKeys={codeGraphs}
                onToggle={(k) => toggle(codeGraphs, setCodeGraphs, k)}
              />
            </CollapseGroup>
            <CollapseGroup
              icon={<ToolsIcon size={16} />}
              title="Skill 技能"
              selectedCount={skills.length}
              totalCount={assets.skills.length}
              open={skillsOpen}
              onToggle={() => setSkillsOpen(!skillsOpen)}
            >
              <AssetCheckList
                assets={assets.skills}
                checkedKeys={skills}
                onToggle={(k) => toggle(skills, setSkills, k)}
              />
            </CollapseGroup>
            <CollapseGroup
              icon={<ChatIcon size={16} />}
              title="Chat_Memory"
              selectedCount={chatMemories.length}
              totalCount={assets.chatMemories.length}
              open={memoryOpen}
              onToggle={() => setMemoryOpen(!memoryOpen)}
            >
              <AssetCheckList
                assets={assets.chatMemories}
                checkedKeys={chatMemories}
                onToggle={(k) => toggle(chatMemories, setChatMemories, k)}
              />
            </CollapseGroup>
          </>
        )}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button
          type="primary"
          disabled={!canSubmit}
          loading={busy}
          onClick={() => onCreated({
            name: name.trim(),
            description: description.trim(),
            rolePrompt: rolePrompt.trim(),
            rulesPrompt: rulesPrompt.trim(),
            skills,
            codeGraphs,
            llmWikis,
            chatMemories,
          })}
        >
          创建
        </Button>
        <Button onClick={onClose} disabled={busy}>取消</Button>
      </Modal.Footer>
    </Modal>
  );
}
