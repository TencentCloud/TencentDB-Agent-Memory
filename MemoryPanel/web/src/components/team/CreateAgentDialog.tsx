/**
 * CreateAgentDialog —— 创建 Agent 弹窗。
 * 支持套用/保存模板、勾选 skills/code_graph/llm_wiki/chat_memory 原子能力。
 */

import { useState } from 'react';
import { Button, Input, Modal, Tag } from 'tea-component';
import { useTranslation } from 'react-i18next';
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
import { LightField, CollapseGroup, AssetCheckList, selectableAssetKeys } from './shared';

export default function CreateAgentDialog({
  team,
  currentUser: _currentUser,
  onClose,
  onCreated,
  busy,
}: {
  /** Agent 严格归属一个 team，这里不让用户在 dialog 里改归属或转交 owner
   *  （owner 由后端在创建时固定为当前登录用户）。 */
  team: { team_id: string; name: string };
  currentUser: string;
  onClose: () => void;
  onCreated: (card: Omit<AgentCard, 'id' | 'icon' | 'accent'>) => void;
  busy: boolean;
}) {
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
  const { t } = useTranslation();

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
    <Modal visible caption={t('createAgent.caption')} size="l" onClose={onClose} disableEscape={busy}>
      <Modal.Body>
        <div className="_memory-form-stack">
          <div className="_memory-modal-description">{t('createAgent.desc')}</div>
        <div className="_memory-target-team-row">
          <span className="_memory-target-team-avatar">{team.name.slice(0, 1).toUpperCase()}</span>
          <div className="_memory-target-team-meta">
            <div className="_memory-target-team-label">{t('createAgent.teamLabel')}</div>
            <div className="_memory-target-team-name-row">
              <span className="_memory-target-team-name">{team.name}</span>
              <Tag size="sm">{team.team_id}</Tag>
            </div>
          </div>
          <div className="_memory-target-team-hint">
            {t('createAgent.teamHint')}
          </div>
        </div>

        <div className="_memory-template-box">
          <div className="_memory-template-box-title-row">
            <span className="_memory-template-box-title">{t('createAgent.template.title')}</span>
            <span className="_memory-template-box-hint">
              {t('createAgent.template.hint')}
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
                      title={t('createAgent.template.delete')}
                      className="_memory-template-chip-close"
                      aria-label={t('createAgent.template.delete')}
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
              <AddIcon size={11} /> {t('createAgent.template.save')}
            </button>
          </div>
          {saveTplOpen && (
            <div className="_memory-template-save-form">
              <div className="_memory-template-save-hint">
                {t('createAgent.template.saveHint')}
              </div>
              <Input
                size="full"
                value={tplName}
                onChange={setTplName}
                placeholder={t('createAgent.template.namePlaceholder')}
              />
              <Input
                size="full"
                value={tplSummary}
                onChange={setTplSummary}
                placeholder={t('createAgent.template.summaryPlaceholder')}
              />
              <div className="_memory-light-field-label">{t('createAgent.template.descLabel')}</div>
              <Input
                size="full"
                value={tplDescription}
                onChange={setTplDescription}
                placeholder={t('createAgent.template.descPlaceholder')}
              />
              <div className="_memory-light-field-label">{t('createAgent.template.roleLabel')}</div>
              <Input.TextArea
                size="full"
                rows={3}
                value={tplRolePrompt}
                onChange={setTplRolePrompt}
                placeholder={t('createAgent.template.rolePlaceholder')}
              />
              <div className="_memory-light-field-label">{t('createAgent.template.rulesLabel')}</div>
              <Input.TextArea
                size="full"
                rows={4}
                value={tplRulesPrompt}
                onChange={setTplRulesPrompt}
                placeholder={t('createAgent.template.rulesPlaceholder')}
                className="_memory-mono-textarea"
              />

              <div className="_memory-template-save-actions">
                <Button onClick={resetSaveTemplateForm}>{t('createAgent.template.cancel')}</Button>
                <Button type="primary"
                  disabled={!tplName.trim()}
                  onClick={handleSaveTemplate}
                >
                  {t('createAgent.template.saveBtn')}
                </Button>
              </div>
            </div>
          )}
        </div>

        <LightField label={t('createAgent.name')}>
          <Input
            autoFocus
            size="full"
            value={name}
            onChange={setName}
            placeholder={t('createAgent.name.placeholder')}
          />
          <div className="_memory-field-hint">
            {t('createAgent.name.hint')}
          </div>
        </LightField>

        <LightField label={t('createAgent.descLabel')} hint={t('createAgent.descHint')}>
          <Input
            size="full"
            value={description}
            onChange={setDescription}
            placeholder={t('createAgent.descPlaceholder')}
          />
        </LightField>

        <LightField
          label={t('createAgent.roleLabel')}
          hint={t('createAgent.roleHint')}
        >
          <Input.TextArea
            size="full"
            value={rolePrompt}
            onChange={setRolePrompt}
            rows={3}
            placeholder={t('createAgent.rolePlaceholder')}
          />
        </LightField>

        <LightField
          label={t('createAgent.rulesLabel')}
          hint={t('createAgent.rulesHint')}
        >
          <Input.TextArea
            size="full"
            value={rulesPrompt}
            onChange={setRulesPrompt}
            rows={4}
            placeholder={t('createAgent.rulesPlaceholder')}
            className="_memory-mono-textarea"
          />
        </LightField>

        {assets.loading ? (
          <div className="_memory-asset-loading">{t('createAgent.assets.loading')}</div>
        ) : (
          <>
            <div className="_memory-asset-toolbar">
              <span className="_memory-asset-toolbar-label">{t('createAgent.assets.label')}</span>
              <button
                type="button"
                onClick={() => {
                  setSkills(selectableAssetKeys(assets.skills));
                  setCodeGraphs(selectableAssetKeys(assets.codeGraphs));
                  setLlmWikis(selectableAssetKeys(assets.wikis));
                  setChatMemories(selectableAssetKeys(assets.chatMemories));
                }}
                className="_memory-asset-toolbar-btn"
              >
                {t('createAgent.assets.selectAll')}
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
                  {t('createAgent.assets.clearAll')}
                </button>
              )}
            </div>
            <CollapseGroup
              icon={<BooksIcon size={16} />}
              title={t('settings.module.wiki')}
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
              title={t('settings.module.code')}
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
              title={t('settings.module.skill')}
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
              title={t('settings.module.chatMemory')}
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
          {t('createAgent.submit')}
        </Button>
        <Button onClick={onClose} disabled={busy}>{t('createAgent.cancel')}</Button>
      </Modal.Footer>
    </Modal>
  );
}
