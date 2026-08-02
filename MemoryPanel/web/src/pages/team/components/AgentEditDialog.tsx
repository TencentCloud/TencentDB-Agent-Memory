/**
 * AgentEditDialog —— 编辑/查看 Agent 弹窗（拆自 TeamManagementPanel）。
 *
 * 编辑范围约定：
 *   - 名称、一句话描述、角色 prompt / 规则 prompt 可编辑保存。
 *   - 资源能力（skills / code_graph / llm_wiki / chat_memory）**只读展示**已绑定项与数量，
 *     不允许在详情里修改 —— 资源绑定仅在「创建 Agent」时设置。
 *
 * 资源已绑定态读真实绑定源（skill 表 owner_agent_id + agent-fixed-asset 表），与运行时一致。
 */

import { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Modal } from 'tea-component';
import { ToolsIcon, CodeIcon, BooksIcon, ChatIcon } from 'tea-icons-react';
import { type Agent as StoreAgent, invalidateBackendCache, writeAgentUiMeta } from '@/services';
import { agentsApi, skillApi, chatMemoryApi } from '@/lib/teamApi';
import { knowledgeApi } from '@/lib/knowledge-api';
import { tea } from '@/lib/tea-bridge';
import { useTeamAssets } from './useAgentAssets';
import { LightField, CollapseGroup, AssetCheckList } from './shared';

export default function AgentEditDialog({
  agent,
  onClose,
}: {
  agent: StoreAgent;
  onClose: () => void;
}) {
  const { t } = useTranslation();
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

  // 资源为只读展示：用真实绑定源填充勾选态（不参与编辑/保存）。
  const [skills, setSkills] = useState<string[]>([]);
  const [codeGraphs, setCodeGraphs] = useState<string[]>([]);
  const [llmWikis, setLlmWikis] = useState<string[]>([]);
  const [chatMemories, setChatMemories] = useState<string[]>([selfChatMemoryId]);
  // agent 真实拥有但可能不在 team 资产池的绑定项（如 skill fork 副本、借入的 memory），
  // 注入资产池以保证「已绑定」项都能显示、数量与 list 卡片一致。
  const [realSkillItems, setRealSkillItems] = useState<Array<{ key: string; title: string }>>([]);
  const [realCodeGraphIds, setRealCodeGraphIds] = useState<string[]>([]);
  const [realWikiIds, setRealWikiIds] = useState<string[]>([]);
  const [realChatMemoryIds, setRealChatMemoryIds] = useState<string[]>([]);
  const [realBindingsLoaded, setRealBindingsLoaded] = useState(false);

  const assets = useTeamAssets(agent.team_id);

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

  // 只读详情：只展示已绑定的项，不展示团队池里的未绑定项。
  const boundSkills = useMemo(
    () => skillsAssets.filter((a) => skills.includes(a.key)),
    [skillsAssets, skills],
  );
  const boundCodeGraphs = useMemo(
    () => codeGraphAssets.filter((a) => codeGraphs.includes(a.key)),
    [codeGraphAssets, codeGraphs],
  );
  const boundWikis = useMemo(
    () => wikiAssets.filter((a) => llmWikis.includes(a.key)),
    [wikiAssets, llmWikis],
  );
  const boundMemories = useMemo(
    () => memoryAssets.filter((a) => chatMemories.includes(a.key)),
    [memoryAssets, chatMemories],
  );

  const agentChanged =
    name !== agent.name
    || description !== agent.description
    || rolePrompt !== agent.role_prompt
    || rulesPrompt !== agent.rules_prompt;

  async function saveAgent() {
    if (!agentChanged || savingPrompt) return;
    const nextName = name.trim();
    const nextDescription = description.trim();
    const nextRolePrompt = rolePrompt.trim();
    const nextRulesPrompt = rulesPrompt.trim();
    if (!nextName) {
      tea.notify.error('Agent 名称不能为空。');
      return;
    }
    setSavingPrompt(true);
    try {
      // 运行时使用 prompt 完整文本；metadata_json 保留两个字段的拆分，供前端再次编辑时恢复。
      await agentsApi.update(agent.agent_id, {
        name: nextName,
        description: nextDescription,
        prompt: [nextRolePrompt, nextRulesPrompt].filter(Boolean).join('\n\n'),
        metadata_json: writeAgentUiMeta(agent.metadata_json, {
          role_prompt: nextRolePrompt,
          rules_prompt: nextRulesPrompt,
        }),
      });
      invalidateBackendCache();
      tea.notify.success('Agent 信息已保存。');
      onClose();
    } catch (error) {
      tea.notify.error(`保存 Agent 信息失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSavingPrompt(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    if (assets.loading || realBindingsLoaded) return () => { cancelled = true; };

    // 读真实绑定源（权威、与运行时一致），仅用于只读展示。
    Promise.allSettled([
      skillApi.listByAgent(agent.team_id, agent.agent_id),
      knowledgeApi.agentFixed(agent.agent_id),
      chatMemoryApi.agentFixed(agent.agent_id),
    ]).then(([skillResult, knowledgeResult, chatResult]) => {
      if (cancelled) return;

      const skillItems = skillResult.status === 'fulfilled' ? skillResult.value : [];
      const nextSkillItems = skillItems.map((s) => ({ key: s.skill_id, title: s.name || s.skill_id }));
      setRealSkillItems(nextSkillItems);
      setSkills(nextSkillItems.map((s) => s.key));

      const knowledgeItems = knowledgeResult.status === 'fulfilled' ? knowledgeResult.value : [];
      const nextCodeGraphs = Array.from(new Set(
        knowledgeItems.filter((it) => it.asset_type === 'code_graph').map((it) => it.knowledge_id),
      ));
      const nextLlmWikis = Array.from(new Set(
        knowledgeItems.filter((it) => it.asset_type === 'llm_wiki').map((it) => it.knowledge_id),
      ));
      setRealCodeGraphIds(nextCodeGraphs);
      setRealWikiIds(nextLlmWikis);
      setCodeGraphs(nextCodeGraphs);
      setLlmWikis(nextLlmWikis);

      const chatItems = chatResult.status === 'fulfilled' ? (chatResult.value.items ?? []) : [];
      const nextChatMemories = Array.from(new Set([selfChatMemoryId, ...chatItems.map((it) => it.id)]));
      setRealChatMemoryIds(nextChatMemories);
      setChatMemories(nextChatMemories);

      setRealBindingsLoaded(true);
    }).catch((err) => {
      if (cancelled) return;
      setRealBindingsLoaded(true);
      const msg = err instanceof Error ? err.message : String(err);
      // 只读模式下后端可能拒绝访问非自己的 agent 资产（NOT_YOUR_AGENT），这是预期行为。
      if (!/NOT_YOUR_AGENT/.test(msg)) {
        tea.notify.error(`加载 Agent 资产绑定失败：${msg}`);
      }
    });

    return () => { cancelled = true; };
  }, [agent, assets.loading, realBindingsLoaded, selfChatMemoryId]);

  return (
    <Modal visible caption={t('team.agents.editAgent', { defaultValue: 'Agent 详情' })} size="l" onClose={onClose}>
      <Modal.Body>
        <div className="_memory-form-stack">
          <div className="_memory-modal-description">{agent.agent_id}</div>
        <LightField label={t('common.name', { defaultValue: '名称' })}>
          <Input size="full" value={name} onChange={setName} disabled={savingPrompt} />
        </LightField>

        <LightField label={t('common.description', { defaultValue: '一句话描述' })}>
          <Input.TextArea size="full" value={description} onChange={setDescription} rows={2} disabled={savingPrompt} />
        </LightField>

        <LightField label="角色定位 prompt">
          <Input.TextArea
            size="full"
            value={rolePrompt}
            onChange={setRolePrompt}
            rows={3}
            disabled={savingPrompt}
            placeholder="描述这个 agent 扮演什么角色 / 职责定位..."
          />
        </LightField>

        <LightField label="规则固定 prompt">
          <Input.TextArea
            size="full"
            value={rulesPrompt}
            onChange={setRulesPrompt}
            rows={4}
            disabled={savingPrompt}
            className="_memory-mono-textarea"
            placeholder="为 Agent 设定行为规则提示词..."
          />
        </LightField>

        <div className="_memory-asset-section">
          {assets.loading ? (
            <div className="_memory-asset-loading">加载团队资产中…</div>
          ) : (
            <>
              <div className="_memory-asset-toolbar">
                <span className="_memory-asset-toolbar-label">原子能力</span>
                <span className="_memory-asset-toolbar-hint">只读 · 资源绑定请在创建或者对应资源管理页面修改设置</span>
              </div>
              <div className="_memory-collapse-group-stack">
                <CollapseGroup
                  icon={<BooksIcon size={16} />}
                  title="Wiki 知识库"
                  selectedCount={llmWikis.length}
                  totalCount={boundWikis.length}
                  open={wikiOpen}
                  onToggle={() => setWikiOpen(!wikiOpen)}
                  hideTotal
                >
                  <AssetCheckList
                    assets={boundWikis}
                    checkedKeys={llmWikis}
                    onToggle={() => {}}
                    readOnly
                  />
                </CollapseGroup>
                <CollapseGroup
                  icon={<CodeIcon size={16} />}
                  title="Code_Graph"
                  selectedCount={codeGraphs.length}
                  totalCount={boundCodeGraphs.length}
                  open={codeGraphOpen}
                  onToggle={() => setCodeGraphOpen(!codeGraphOpen)}
                  hideTotal
                >
                  <AssetCheckList
                    assets={boundCodeGraphs}
                    checkedKeys={codeGraphs}
                    onToggle={() => {}}
                    readOnly
                  />
                </CollapseGroup>
                <CollapseGroup
                  icon={<ToolsIcon size={16} />}
                  title="Skill 技能"
                  selectedCount={skills.length}
                  totalCount={boundSkills.length}
                  open={skillsOpen}
                  onToggle={() => setSkillsOpen(!skillsOpen)}
                  hideTotal
                >
                  <AssetCheckList
                    assets={boundSkills}
                    checkedKeys={skills}
                    onToggle={() => {}}
                    readOnly
                  />
                </CollapseGroup>
                <CollapseGroup
                  icon={<ChatIcon size={16} />}
                  title="Chat_Memory"
                  selectedCount={chatMemories.length}
                  totalCount={boundMemories.length}
                  open={memoryOpen}
                  onToggle={() => setMemoryOpen(!memoryOpen)}
                  hideTotal
                >
                  <AssetCheckList
                    assets={boundMemories}
                    checkedKeys={chatMemories}
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
        <Button onClick={onClose} disabled={savingPrompt}>取消</Button>
        <Button type="primary" onClick={() => void saveAgent()} disabled={!agentChanged || savingPrompt} loading={savingPrompt}>
          保存修改
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
