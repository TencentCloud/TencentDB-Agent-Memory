/**
 * DefaultAgentTemplateDialog —— 默认 Agent 模板配置弹窗（仅全局 admin）。
 *
 * 表单字段与「创建 Agent」对齐，但只允许选择**团队公共资产**
 * （useTeamAssets 内部已按 visibility=team 过滤 skill / code_graph / wiki；
 * 模板的 asset_ids 不支持 chat_memory，故不提供记忆勾选）。
 *
 * 保存走 agent/set-default-template（覆盖式写入，一次回传完整 template）。
 * 已配置时打开弹窗会用 get-default-template 的返回值预填。
 */

import { useState } from 'react';
import { Button, Input, Modal, Tag } from 'tea-component';
import { useTranslation } from 'react-i18next';
import { BooksIcon, CodeIcon, ToolsIcon } from 'tea-icons-react';
import { agentsApi, type AgentTemplateConfig } from '@/lib/teamApi';
import { writeAgentUiMeta } from '@/services';
import { tea } from '@/lib/tea-bridge';
import { getErrorMessage } from '@/lib/error-message';
import { LightField, CollapseGroup, AssetCheckList, selectableAssetKeys } from './shared';
import { useTeamAssets } from './useAgentAssets';

/** 从模板 metadata_json（JSON 字符串）读取 ui.role_prompt / ui.rules_prompt。 */
function readTemplatePrompts(tpl: AgentTemplateConfig): { rolePrompt: string; rulesPrompt: string } {
  let rolePrompt = '';
  let rulesPrompt = '';
  if (tpl.metadata_json) {
    try {
      const meta = JSON.parse(tpl.metadata_json) as { ui?: { role_prompt?: string; rules_prompt?: string } };
      rolePrompt = meta?.ui?.role_prompt ?? '';
      rulesPrompt = meta?.ui?.rules_prompt ?? '';
    } catch {
      /* metadata_json 不合法按空处理 */
    }
  }
  // 没有 ui 拆分时回退到整体 prompt（与 Agent 详情展示口径一致）
  if (!rolePrompt && tpl.prompt) rolePrompt = tpl.prompt;
  return { rolePrompt, rulesPrompt };
}

export default function DefaultAgentTemplateDialog({
  team,
  initial,
  onClose,
  onSaved,
}: {
  team: { team_id: string; name: string };
  /** 已配置的模板（用于预填表单）；null = 首次新建 */
  initial: AgentTemplateConfig | null;
  onClose: () => void;
  onSaved: (tpl: AgentTemplateConfig) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [rolePrompt, setRolePrompt] = useState(() => readTemplatePrompts(initial ?? { name: '' }).rolePrompt);
  const [rulesPrompt, setRulesPrompt] = useState(() => readTemplatePrompts(initial ?? { name: '' }).rulesPrompt);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [codeGraphOpen, setCodeGraphOpen] = useState(false);
  const [wikiOpen, setWikiOpen] = useState(false);
  const [skills, setSkills] = useState<string[]>(initial?.asset_ids?.skills ?? []);
  const [codeGraphs, setCodeGraphs] = useState<string[]>(initial?.asset_ids?.code_graphs ?? []);
  const [llmWikis, setLlmWikis] = useState<string[]>(initial?.asset_ids?.wikis ?? []);
  const [busy, setBusy] = useState(false);

  // 团队公共资产（skill / code_graph / wiki，后端 bootstrap 已按 visibility=team 过滤）
  const assets = useTeamAssets(team.team_id);

  const canSubmit = name.trim().length > 0 && !busy;
  const totalSelected = skills.length + codeGraphs.length + llmWikis.length;

  function toggle(list: string[], setList: (v: string[]) => void, key: string) {
    setList(list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);
  }

  async function handleSave() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const metadataJson = writeAgentUiMeta(undefined, {
        role_prompt: rolePrompt.trim(),
        rules_prompt: rulesPrompt.trim(),
      });
      const template: AgentTemplateConfig = {
        name: name.trim(),
        description: description.trim() || null,
        prompt: [rolePrompt.trim(), rulesPrompt.trim()].filter(Boolean).join('\n\n'),
        visibility: 'team',
        metadata_json: metadataJson,
        asset_ids: { skills, code_graphs: codeGraphs, wikis: llmWikis },
      };
      await agentsApi.setDefaultTemplate(team.team_id, template);
      onSaved(template);
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      visible
      caption={initial ? t('defaultAgent.edit.caption') : t('defaultAgent.create.caption')}
      size="l"
      onClose={onClose}
      disableEscape={busy}
    >
      <Modal.Body>
        <div className="_memory-form-stack">
          <div className="_memory-modal-description">
            {initial ? t('defaultAgent.edit.desc') : t('defaultAgent.create.desc')}
          </div>
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

          <LightField label={t('defaultAgent.name')}>
            <Input
              size="full"
              value={name}
              onChange={setName}
              placeholder={t('createAgent.name.placeholder')}
            />
            <div className="_memory-field-hint">
              {t('defaultAgent.name.hint')}
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
                <span className="_memory-asset-toolbar-label">
                  {t('defaultAgent.assets.label')}
                </span>
                <span className="_memory-asset-toolbar-hint">
                  {t('defaultAgent.assets.hint')}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setSkills(selectableAssetKeys(assets.skills));
                    setCodeGraphs(selectableAssetKeys(assets.codeGraphs));
                    setLlmWikis(selectableAssetKeys(assets.wikis));
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
            </>
          )}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" disabled={!canSubmit} loading={busy} onClick={handleSave}>
          {initial ? t('defaultAgent.save') : t('defaultAgent.create.submit')}
        </Button>
        <Button onClick={onClose} disabled={busy}>{t('createAgent.cancel')}</Button>
      </Modal.Footer>
    </Modal>
  );
}
