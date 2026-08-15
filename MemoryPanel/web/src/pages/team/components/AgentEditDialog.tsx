/**
 * AgentEditDialog —— 编辑/查看 Agent 弹窗。
 *
 * 编辑范围约定：
 *   - 名称、一句话描述、角色 prompt / 规则 prompt 可编辑保存。
 *   - 资源能力可直接在本弹窗勾选/解绑并保存：
 *     · Wiki 知识库 / CodeGraph → allocate / unbind（引用绑定，增量 diff）
 *     · Chat Memory → setAgentFixed（全量覆盖，天然处理增删；不含 agent 自身 memory）
 *     · Skill → 仍只读展示。skill 的「挂载」语义是 fork 出 owner=该 agent 的独立副本
 *       （见 skillApi.forkToAgent），在编辑弹窗里做增删副本涉及乐观锁与归档，
 *       风险高，本期不放开，保留在「创建 Agent」/技能管理页维护。
 *
 * 资源已绑定态读真实绑定源（skill 表 owner_agent_id + agent-fixed-asset 表），与运行时一致。
 */

import { useState, useMemo, useEffect } from 'react';
import { Button, Input, Modal } from 'tea-component';
import { useTranslation } from 'react-i18next';
import { ToolsIcon, CodeIcon, BooksIcon, ChatIcon } from 'tea-icons-react';
import { type Agent as StoreAgent, invalidateBackendCache, writeAgentUiMeta } from '@/services';
import { agentsApi, skillApi, chatMemoryApi } from '@/lib/teamApi';
import { knowledgeApi } from '@/lib/knowledge-api';
import { tea } from '@/lib/tea-bridge';
import { useTeamAssets, syncChatMemoryBindings } from './useAgentAssets';
import { LightField, CollapseGroup, AssetCheckList } from './shared';

export default function AgentEditDialog({
  agent,
  onClose,
}: {
  agent: StoreAgent;
  onClose: () => void;
}) {
  const selfChatMemoryId = `chat_memory-${agent.team_id}-${agent.agent_id}`;
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const [rolePrompt, setRolePrompt] = useState(agent.role_prompt);
  const [rulesPrompt, setRulesPrompt] = useState(agent.rules_prompt);
  const [savingPrompt, setSavingPrompt] = useState(false);

  const [codeGraphOpen, setCodeGraphOpen] = useState(false);
  const [wikiOpen, setWikiOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);

  // 资源可编辑：用真实绑定源填充初始勾选态。
  const [skills, setSkills] = useState<string[]>([]);
  const [codeGraphs, setCodeGraphs] = useState<string[]>([]);
  const [llmWikis, setLlmWikis] = useState<string[]>([]);
  const [chatMemories, setChatMemories] = useState<string[]>([selfChatMemoryId]);
  // 初始绑定快照：保存时与当前勾选对比算增删 diff（skill 只读不参与 diff）。
  const [initialCodeGraphs, setInitialCodeGraphs] = useState<string[]>([]);
  const [initialWikis, setInitialWikis] = useState<string[]>([]);
  const [initialChatMemories, setInitialChatMemories] = useState<string[]>([selfChatMemoryId]);
  const [savingAssets, setSavingAssets] = useState(false);
  // agent 真实拥有但可能不在 team 资产池的绑定项（如 skill fork 副本、借入的 memory），
  // 注入资产池以保证「已绑定」项都能显示、数量与 list 卡片一致。
  const [realSkillItems, setRealSkillItems] = useState<Array<{ key: string; title: string }>>([]);
  const [realCodeGraphIds, setRealCodeGraphIds] = useState<string[]>([]);
  const [realWikiIds, setRealWikiIds] = useState<string[]>([]);
  const [realChatMemoryIds, setRealChatMemoryIds] = useState<string[]>([]);
  const [realBindingsLoaded, setRealBindingsLoaded] = useState(false);

  const assets = useTeamAssets(agent.team_id);
  const { t } = useTranslation();

  // 加载态编排：
  //   assets.loading —— 团队资产池在加载（4 个折叠组都用资产池数据）
  //   realBindingsLoaded —— 真实绑定源已就绪（决定折叠组 count 是否可信）
  // 任一未就绪 → 折叠组走骨架占位，避免「已选 0/共 0 → 真实数字」跳变。
  const bindingsLoading = assets.loading || !realBindingsLoaded;

  function injectBound<T extends { key: string; title: string; group: string; slug: string }>(
    pool: T[],
    boundIds: string[],
    group: string,
  ): T[] {
    const map = new Map(pool.map((item) => [item.key, item]));
    for (const id of boundIds) {
      if (!map.has(id)) {
        map.set(id, { key: id, title: id, group, slug: id } as T);
      }
    }
    return Array.from(map.values());
  }

  const skillsAssets = useMemo(() => {
    const map = new Map(assets.skills.map((item) => [item.key, item]));
    for (const it of realSkillItems) {
      if (!map.has(it.key)) {
        map.set(it.key, { key: it.key, title: it.title, group: 'SKILL', slug: it.key });
      }
    }
    return Array.from(map.values());
  }, [assets.skills, realSkillItems]);
  const codeGraphAssets = useMemo(
    () => injectBound(assets.codeGraphs, realCodeGraphIds, 'CODE'),
    [assets.codeGraphs, realCodeGraphIds],
  );
  const wikiAssets = useMemo(
    () => injectBound(assets.wikis, realWikiIds, 'WIKI'),
    [assets.wikis, realWikiIds],
  );
  const memoryAssets = useMemo(() => {
    const map = new Map(assets.chatMemories.map((item) => [item.key, item]));
    if (!map.has(selfChatMemoryId)) {
      map.set(selfChatMemoryId, {
        key: selfChatMemoryId,
        title: agent.name,
        group: 'MEMORY',
        slug: selfChatMemoryId,
      });
    }
    for (const id of realChatMemoryIds) {
      if (!map.has(id)) {
        map.set(id, { key: id, title: id, group: 'MEMORY', slug: id });
      }
    }
    return Array.from(map.values());
  }, [agent.name, realChatMemoryIds, assets.chatMemories, selfChatMemoryId]);

  // 可编辑：展示团队资产池全集（含已绑定与未绑定），供用户勾选/取消。
  // skill 仍只读，只展示已绑定项（fork 语义，见文件头说明）。
  const boundSkills = useMemo(
    () => skillsAssets.filter((a) => skills.includes(a.key)),
    [skillsAssets, skills],
  );

  function toggle(list: string[], setList: (v: string[]) => void, key: string) {
    setList(list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);
  }

  // 资产是否相对初始绑定发生变化（用于启用保存按钮）
  const sameSet = (a: string[], b: string[]) =>
    a.length === b.length && a.every((x) => b.includes(x));
  const assetsChanged =
    !sameSet(codeGraphs, initialCodeGraphs) ||
    !sameSet(llmWikis, initialWikis) ||
    !sameSet(chatMemories, initialChatMemories);

  const promptChanged =
    name !== agent.name ||
    description !== agent.description ||
    rolePrompt !== agent.role_prompt ||
    rulesPrompt !== agent.rules_prompt;
  const agentChanged = promptChanged || assetsChanged;
  const saving = savingPrompt || savingAssets;

  /** 保存资产绑定 diff：wiki / code_graph 走 allocate/unbind，chat_memory 走全量 setAgentFixed。 */
  async function saveAssetBindings() {
    // Wiki
    for (const id of llmWikis.filter((x) => !initialWikis.includes(x))) {
      await knowledgeApi.wiki.allocate(agent.team_id, id, agent.agent_id);
    }
    for (const id of initialWikis.filter((x) => !llmWikis.includes(x))) {
      await knowledgeApi.wiki.unbind(id, agent.agent_id);
    }
    // CodeGraph
    for (const id of codeGraphs.filter((x) => !initialCodeGraphs.includes(x))) {
      await knowledgeApi.code.allocate(agent.team_id, id, agent.agent_id);
    }
    for (const id of initialCodeGraphs.filter((x) => !codeGraphs.includes(x))) {
      await knowledgeApi.code.unbind(id, agent.agent_id);
    }
    // Chat Memory：全量覆盖（内部会过滤自身 memory、校验借入上限）
    if (!sameSet(chatMemories, initialChatMemories)) {
      await syncChatMemoryBindings(agent.team_id, agent.agent_id, chatMemories);
    }
  }

  async function saveAgent() {
    if (!agentChanged || saving) return;
    const nextName = name.trim();
    const nextDescription = description.trim();
    const nextRolePrompt = rolePrompt.trim();
    const nextRulesPrompt = rulesPrompt.trim();
    if (!nextName) {
      tea.notify.error(t('agentEdit.notify.nameRequired'));
      return;
    }
    setSavingPrompt(true);
    setSavingAssets(true);
    try {
      // 运行时使用 prompt 完整文本；metadata_json 保留两个字段的拆分，供前端再次编辑时恢复。
      if (promptChanged) {
        await agentsApi.update(agent.agent_id, {
          name: nextName,
          description: nextDescription,
          prompt: [nextRolePrompt, nextRulesPrompt].filter(Boolean).join('\n\n'),
          metadata_json: writeAgentUiMeta(agent.metadata_json, {
            role_prompt: nextRolePrompt,
            rules_prompt: nextRulesPrompt,
          }),
        });
      }
      if (assetsChanged) {
        await saveAssetBindings();
      }
      invalidateBackendCache();
      tea.notify.success(t('agentEdit.notify.saved'));
      onClose();
    } catch (error) {
      tea.notify.error(
        t('agentEdit.notify.saveFailed', {
          msg: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setSavingPrompt(false);
      setSavingAssets(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    if (assets.loading || realBindingsLoaded)
      return () => {
        cancelled = true;
      };

    // 读真实绑定源（权威、与运行时一致），仅用于只读展示。
    Promise.allSettled([
      skillApi.listByAgent(agent.team_id, agent.agent_id),
      knowledgeApi.agentFixed(agent.agent_id),
      chatMemoryApi.agentFixed(agent.agent_id),
    ])
      .then(([skillResult, knowledgeResult, chatResult]) => {
        if (cancelled) return;

        const skillItems = skillResult.status === 'fulfilled' ? skillResult.value : [];
        const nextSkillItems = skillItems.map((s) => ({
          key: s.skill_id,
          title: s.name || s.skill_id,
        }));
        setRealSkillItems(nextSkillItems);
        setSkills(nextSkillItems.map((s) => s.key));

        const knowledgeItems = knowledgeResult.status === 'fulfilled' ? knowledgeResult.value : [];
        const nextCodeGraphs = Array.from(
          new Set(
            knowledgeItems
              .filter((it) => it.asset_type === 'code_graph')
              .map((it) => it.knowledge_id),
          ),
        );
        const nextLlmWikis = Array.from(
          new Set(
            knowledgeItems
              .filter((it) => it.asset_type === 'llm_wiki')
              .map((it) => it.knowledge_id),
          ),
        );
        setRealCodeGraphIds(nextCodeGraphs);
        setRealWikiIds(nextLlmWikis);
        setCodeGraphs(nextCodeGraphs);
        setLlmWikis(nextLlmWikis);
        setInitialCodeGraphs(nextCodeGraphs);
        setInitialWikis(nextLlmWikis);

        const chatItems = chatResult.status === 'fulfilled' ? (chatResult.value.items ?? []) : [];
        const nextChatMemories = Array.from(
          new Set([selfChatMemoryId, ...chatItems.map((it) => it.id)]),
        );
        setRealChatMemoryIds(nextChatMemories);
        setChatMemories(nextChatMemories);
        setInitialChatMemories(nextChatMemories);

        setRealBindingsLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setRealBindingsLoaded(true);
        const msg = err instanceof Error ? err.message : String(err);
        // 只读模式下后端可能拒绝访问非自己的 agent 资产（NOT_YOUR_AGENT），这是预期行为。
        if (!/NOT_YOUR_AGENT/.test(msg)) {
          tea.notify.error(t('agentEdit.notify.loadAssetsFailed', { msg }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [agent, assets.loading, realBindingsLoaded, selfChatMemoryId]);

  return (
    <Modal visible caption={t('agentEdit.caption')} size="l" onClose={onClose}>
      <Modal.Body>
        <div className="_memory-form-stack">
          <div className="_memory-modal-description">{agent.agent_id}</div>
          <LightField label={t('agentEdit.name')}>
            <Input size="full" value={name} onChange={setName} disabled={saving} />
          </LightField>

          <LightField label={t('agentEdit.descLabel')}>
            <Input.TextArea
              size="full"
              value={description}
              onChange={setDescription}
              rows={2}
              disabled={saving}
            />
          </LightField>

          <LightField label={t('agentEdit.roleLabel')}>
            <Input.TextArea
              size="full"
              value={rolePrompt}
              onChange={setRolePrompt}
              rows={3}
              disabled={saving}
              placeholder={t('agentEdit.rolePlaceholder')}
            />
          </LightField>

          <LightField label={t('agentEdit.rulesLabel')}>
            <Input.TextArea
              size="full"
              value={rulesPrompt}
              onChange={setRulesPrompt}
              rows={4}
              disabled={saving}
              className="_memory-mono-textarea"
              placeholder={t('agentEdit.rulesPlaceholder')}
            />
          </LightField>

          <div className="_memory-asset-section">
            {bindingsLoading ? (
              // 整个资产区域加载中：骨架占位 4 个折叠组的轮廓
              <div className="_memory-asset-section-loading" aria-label="loading assets">
                <div className="_memory-asset-loading">{t('agentEdit.assets.loading')}</div>
                <div className="_memory-collapse-group-stack">
                  {[0, 1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className="_memory-collapse-group _memory-collapse-group--loading"
                      style={{ animationDelay: `${i * 60}ms` }}
                    >
                      <div className="_memory-collapse-group-header">
                        <span className="_memory-collapse-group-chevron" />
                        <span className="_memory-collapse-group-title">
                          <span className="_memory-collapse-group-title-skeleton" />
                        </span>
                        <span className="_memory-collapse-group-count _memory-collapse-group-count--loading" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <>
                <div className="_memory-asset-toolbar">
                  <span className="_memory-asset-toolbar-label">{t('agentEdit.assets.label')}</span>
                  <span className="_memory-asset-toolbar-hint">
                    {t('agentEdit.assets.editHint')}
                  </span>
                </div>
                <div className="_memory-collapse-group-stack">
                  <CollapseGroup
                    icon={<BooksIcon size={16} />}
                    title={t('settings.module.wiki')}
                    selectedCount={llmWikis.length}
                    totalCount={wikiAssets.length}
                    open={wikiOpen}
                    onToggle={() => setWikiOpen(!wikiOpen)}
                  >
                    <AssetCheckList
                      assets={wikiAssets}
                      checkedKeys={llmWikis}
                      onToggle={(k) => toggle(llmWikis, setLlmWikis, k)}
                    />
                  </CollapseGroup>
                  <CollapseGroup
                    icon={<CodeIcon size={16} />}
                    title={t('settings.module.code')}
                    selectedCount={codeGraphs.length}
                    totalCount={codeGraphAssets.length}
                    open={codeGraphOpen}
                    onToggle={() => setCodeGraphOpen(!codeGraphOpen)}
                  >
                    <AssetCheckList
                      assets={codeGraphAssets}
                      checkedKeys={codeGraphs}
                      onToggle={(k) => toggle(codeGraphs, setCodeGraphs, k)}
                    />
                  </CollapseGroup>
                  <CollapseGroup
                    icon={<ChatIcon size={16} />}
                    title={t('settings.module.chatMemory')}
                    selectedCount={chatMemories.length}
                    totalCount={memoryAssets.length}
                    open={memoryOpen}
                    onToggle={() => setMemoryOpen(!memoryOpen)}
                  >
                    <AssetCheckList
                      assets={memoryAssets}
                      checkedKeys={chatMemories}
                      onToggle={(k) => toggle(chatMemories, setChatMemories, k)}
                      disabledKeys={new Set([selfChatMemoryId])}
                    />
                  </CollapseGroup>
                  {/* Skill 仍只读：其绑定是 fork 独立副本，编辑弹窗不做增删（见文件头说明） */}
                  <CollapseGroup
                    icon={<ToolsIcon size={16} />}
                    title={t('settings.module.skill')}
                    selectedCount={skills.length}
                    totalCount={boundSkills.length}
                    open={skillsOpen}
                    onToggle={() => setSkillsOpen(!skillsOpen)}
                    hideTotal
                  >
                    <div className="_memory-asset-readonly-hint">
                      {t('agentEdit.assets.skillReadonly')}
                    </div>
                    <AssetCheckList
                      assets={boundSkills}
                      checkedKeys={skills}
                      onToggle={() => {}}
                      readOnly
                    />
                  </CollapseGroup>
                </div>
              </>
            )}
          </div>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button onClick={onClose} disabled={saving}>
          {t('agentEdit.cancel')}
        </Button>
        <Button
          type="primary"
          onClick={() => void saveAgent()}
          disabled={!agentChanged || saving}
          loading={saving}
        >
          {t('agentEdit.save')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
