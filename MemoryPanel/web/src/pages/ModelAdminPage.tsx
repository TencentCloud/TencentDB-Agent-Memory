/**
 * ModelAdminPage — 菜单 1「模型管理」。
 *
 * 三个功能：
 *   1. 看：列出每个 Agent 现在用哪个模型 / 哪个供应商 / 哪个 Key（Key 脱敏）
 *   2. 改：新增 / 修改上游分组（供应商地址、API Key、模型 ID、绑给哪几个 Agent）
 *   3. 测：一键测连通，直接显示成功/失败与上游报错原文
 *
 * 改完立即生效（Proxy 侧 instance-upstream 缓存 TTL 默认 30s），不需要重启。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Table,
  Card,
  Button,
  Alert,
  Text,
  Justify,
  H3,
  Form,
  Modal,
  Input,
  Select,
  Switch,
  Checkbox,
  Badge,
} from 'tea-component';
import { metaPost } from '@/lib/api/base';
import { systemApi, type SupportedAgent, type UpstreamGroup, type UpstreamTestResult } from '@/lib/api/system';
import { ModelPickerModal } from '@/components/ModelPickerModal';
import { teamsApi } from '@/lib/api/teams';
import type { Team } from '@/lib/api/types';

const { autotip } = Table.addons;

const MODE_LABEL: Record<string, string> = {
  official: '官方通道',
  custom_unified: '自定义（统一 Key）',
  custom_passthrough: '自定义（透传客户端 Key）',
};

const PROTOCOL_LABEL: Record<string, string> = {
  anthropic: 'Anthropic /v1/messages',
  'openai-chat': 'OpenAI /v1/chat/completions',
  'openai-responses': 'OpenAI /v1/responses',
};

interface FormState {
  name: string;
  agents: string[];
  mode: 'custom_unified' | 'custom_passthrough';
  base_url: string;
  api_key: string;
  /** 多模型清单：非空时客户端只能看到/选用清单内模型，[0] 为默认模型 */
  model_ids: string[];
  /** 手动添加模型 ID 的临时输入框值 */
  modelInput: string;
  /** P3：团队专属归属（空 = 全局组），创建后不可改 */
  team_id: string;
  protocol: string;
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  agents: [],
  mode: 'custom_unified',
  base_url: '',
  api_key: '',
  model_ids: [],
  modelInput: '',
  team_id: '',
  protocol: 'openai-chat',
  enabled: true,
};

export function ModelAdminPage() {
  const [groups, setGroups] = useState<UpstreamGroup[]>([]);
  const [agents, setAgents] = useState<SupportedAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<UpstreamGroup | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<UpstreamTestResult | null>(null);

  // P1：供应商模型列表弹窗状态
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerModels, setPickerModels] = useState<string[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState('');

  // P3：团队列表（供「生效团队」选择）
  const [teams, setTeams] = useState<Team[]>([]);

  /** 编辑「官方内置」组时，只能改生效 Agent 与启用状态 */
  const isDefaultGroup = editing?.group_type === 'default';
  const hideIfDefault = isDefaultGroup ? { display: 'none' } : undefined;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [groupData, agentData] = await Promise.all([
        metaPost<{ items?: UpstreamGroup[] } | UpstreamGroup[]>('instance-upstream/groups/list', {}),
        metaPost<{ items?: SupportedAgent[] } | SupportedAgent[]>('upstream/supported-agents', {}),
      ]);
      const groupList = Array.isArray(groupData)
        ? groupData
        : ((groupData as { items?: UpstreamGroup[] }).items ?? []);
      const agentList = Array.isArray(agentData)
        ? agentData
        : ((agentData as { items?: SupportedAgent[] }).items ?? []);
      setGroups(groupList);
      setAgents(agentList);
      // P3: 团队列表拉取失败不阻塞主功能
      try {
        setTeams(await teamsApi.list());
      } catch {
        setTeams([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** agent → 生效分组（custom 优先于 default） */
  const agentBinding = useMemo(() => {
    const map = new Map<string, UpstreamGroup>();
    for (const g of groups) {
      if (g.group_type === 'extraction' || !g.enabled) continue;
      for (const a of g.agents ?? []) {
        const prev = map.get(a);
        if (!prev || (prev.group_type === 'default' && g.group_type === 'custom')) {
          map.set(a, g);
        }
      }
    }
    return map;
  }, [groups]);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setTestResult(null);
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditing(null);
    setForm(EMPTY_FORM);
    setTestResult(null);
  };

  const openEdit = (row: UpstreamGroup) => {
    setEditing(row);
    setModalOpen(true);
    setForm({
      name: row.name ?? '',
      agents: row.agents ?? [],
      mode: row.mode === 'custom_passthrough' ? 'custom_passthrough' : 'custom_unified',
      base_url: row.base_url ?? '',
      // 后端下发的是脱敏值（含 •），留空表示不修改
      api_key: '',
      model_ids: row.model_ids ?? (row.model_id ? [row.model_id] : []),
      modelInput: '',
      team_id: row.team_id ?? '',
      protocol: 'openai-chat',
      enabled: row.enabled !== false,
    });
    setTestResult(null);
  };

  const save = async () => {
    if (!form.name.trim()) {
      setError('请填写分组名称');
      return;
    }
    if (form.agents.length === 0) {
      setError('请至少选择一个 Agent');
      return;
    }
    if (!form.base_url.trim()) {
      setError('请填写供应商地址');
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (editing && editing.group_type === 'default') {
        // P2：default 组可改「生效 Agent / 启用 / 供应商地址 / API Key / 模型清单」；
        // base_url 留空 = 沿用部署配置（config.yaml），api_key 留空 = 沿用部署 Key
        const body: Record<string, unknown> = {
          group_id: editing.group_id,
          group_type: 'default',
          agents: form.agents,
          enabled: form.enabled,
          base_url: form.base_url.trim(),
          model_ids: form.model_ids,
          model_id: form.model_ids[0] || '',
          ...(editing.version !== undefined ? { expected_version: editing.version } : {}),
        };
        if (form.api_key) body.api_key = form.api_key;
        await metaPost('instance-upstream/groups/update', body);
      } else if (editing) {
        const body: Record<string, unknown> = {
          group_id: editing.group_id,
          group_type: editing.group_type === 'extraction' ? 'custom' : editing.group_type,
          name: form.name,
          agents: form.agents,
          mode: form.mode,
          base_url: form.base_url,
          enabled: form.enabled,
          model_ids: form.model_ids,
          model_id: form.model_ids[0] || undefined,
        };
        if (form.api_key) body.api_key = form.api_key;
        if (editing.version !== undefined) body.expected_version = editing.version;
        await metaPost('instance-upstream/groups/update', body);
      } else {
        await metaPost('instance-upstream/groups/create', {
          group_type: 'custom',
          name: form.name,
          agents: form.agents,
          mode: form.mode,
          base_url: form.base_url,
          api_key: form.api_key || undefined,
          model_ids: form.model_ids,
          model_id: form.model_ids[0] || undefined,
          team_id: form.team_id || undefined,
          enabled: form.enabled,
        });
      }
      closeModal();
      await refresh();
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      // 内核的 AGENTS_OVERLAP 是英文，这里翻成可执行的动作
      setError(
        raw.includes('AGENTS_OVERLAP')
          ? '该 Agent 已被其它分组占用（一个 Agent 同时只能属于一个组）。请先在「默认上游」组里把它取消勾选并保存，再来新建自定义分组。'
          : raw,
      );
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (row: UpstreamGroup) => {
    try {
      await metaPost('instance-upstream/groups/toggle', {
        group_id: row.group_id,
        enabled: !row.enabled,
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (row: UpstreamGroup) => {
    try {
      await metaPost('instance-upstream/groups/delete', { group_id: row.group_id });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const test = async () => {
    const modelForTest = form.model_ids[0] || editing?.model_ids?.[0] || editing?.model_id || '';
    if (!modelForTest) {
      setTestResult({
        ok: false,
        status: 0,
        statusText: 'MISSING_MODEL',
        latencyMs: 0,
        requestUrl: '',
        modelEcho: '',
        responsePreview: '请先添加模型（可点「从供应商获取」或手动输入），再测试连通性',
      });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await systemApi.testUpstream({
        base_url: form.base_url || editing?.base_url || '',
        api_key: form.api_key,
        model_id: modelForTest,
        protocol: form.protocol,
      });
      setTestResult(result);
    } catch (err) {
      setTestResult({
        ok: false,
        status: 0,
        statusText: 'REQUEST_FAILED',
        latencyMs: 0,
        requestUrl: '',
        modelEcho: '',
        responsePreview: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  };

  /** P1：从供应商拉取模型列表并弹窗选择 */
  const fetchModels = async () => {
    const baseUrl = form.base_url || editing?.base_url || '';
    if (!baseUrl) {
      setPickerError('请先填写供应商地址');
      setPickerVisible(true);
      setPickerModels([]);
      return;
    }
    setPickerVisible(true);
    setPickerLoading(true);
    setPickerError('');
    setPickerModels([]);
    try {
      const result = await systemApi.listUpstreamModels({
        base_url: baseUrl,
        api_key: form.api_key,
        protocol: form.protocol,
      });
      if (result.ok) {
        setPickerModels(result.models);
        if (result.models.length === 0) setPickerError('供应商返回了空模型列表');
      } else {
        setPickerError(result.error || '拉取失败');
      }
    } catch (err) {
      setPickerError(err instanceof Error ? err.message : String(err));
    } finally {
      setPickerLoading(false);
    }
  };

  return (
    <div style={{ padding: 20 }}>
      <Justify
        left={
          <div>
            <H3>模型管理</H3>
            <Text theme="weak">
              为每个 Agent 指定模型供应商。改完立即生效（约 30 秒内），<b>不需要重启</b>。
            </Text>
          </div>
        }
        right={
          <Button type="primary" onClick={openCreate}>
            新增上游分组
          </Button>
        }
      />

      <Alert type="info" style={{ marginTop: 12 }}>
        一个 Agent 同时<b>只能属于一个分组</b>。「默认上游」覆盖全部 Agent、走部署时配置的供应商，
        现在也可以直接改它的地址 / Key / 模型清单（留空 = 沿用部署配置）。
        要给某个 Agent 单独换供应商：先在默认上游里取消勾选它并保存，再新建自定义分组。
      </Alert>

      {error ? (
        <Alert type="error" style={{ marginTop: 12 }}>
          {error}
        </Alert>
      ) : null}

      <Card style={{ marginTop: 16 }}>
        <Card.Body title="上游分组（可编辑：编辑 / 停用 / 删除 / 新增）">
          <Table
            records={groups}
            recordKey="group_id"
            columns={[
              { key: 'name', header: '分组名', render: (r: UpstreamGroup) => r.name },
              {
                key: 'group_type',
                header: '类型',
                render: (r: UpstreamGroup) =>
                  r.group_type === 'custom' ? '自定义' : r.group_type === 'default' ? '默认上游' : '抽取',
              },
              {
                key: 'agents',
                header: '生效 Agent',
                render: (r: UpstreamGroup) => (r.agents ?? []).join(', ') || '-',
              },
              {
                key: 'team_id',
                header: '生效团队',
                render: (r: UpstreamGroup) => {
                  const tid = r.team_id ?? '';
                  if (!tid) return <Text theme="weak">全局</Text>;
                  const t = teams.find((x) => x.team_id === tid);
                  return <Badge theme="success">{t ? t.name : tid}</Badge>;
                },
              },
              {
                key: 'mode',
                header: '模式',
                render: (r: UpstreamGroup) => MODE_LABEL[r.mode] ?? r.mode,
              },
              { key: 'base_url', header: '供应商地址', render: (r: UpstreamGroup) => r.base_url || '-' },
              {
                key: 'model_id',
                header: '模型清单',
                render: (r: UpstreamGroup) => {
                  const list = r.model_ids ?? (r.model_id ? [r.model_id] : []);
                  if (list.length === 0) return <Text theme="weak">沿用请求里的 model</Text>;
                  return (
                    <Text>
                      {list[0]}
                      {list.length > 1 ? <Text theme="weak"> 等 {list.length} 个</Text> : null}
                    </Text>
                  );
                },
              },
              {
                key: 'enabled',
                header: '状态',
                render: (r: UpstreamGroup) => (
                  <Badge theme={r.enabled ? 'success' : 'danger'}>{r.enabled ? '启用' : '停用'}</Badge>
                ),
              },
              {
                key: 'ops',
                header: '操作',
                render: (r: UpstreamGroup) => (
                  <Text>
                    {r.group_type !== 'extraction' ? (
                      <Button type="link" onClick={() => openEdit(r)}>
                        编辑
                      </Button>
                    ) : null}
                    <Button type="link" onClick={() => void toggle(r)}>
                      {r.enabled ? '停用' : '启用'}
                    </Button>
                    {r.group_type === 'custom' ? (
                      <Button type="link" onClick={() => void remove(r)}>
                        删除
                      </Button>
                    ) : null}
                  </Text>
                ),
              },
            ]}
            addons={[autotip({ isLoading: loading, emptyText: '暂无分组' })]}
          />
        </Card.Body>
      </Card>

      <Card style={{ marginTop: 16 }}>
        <Card.Body title="各 Agent 当前生效的模型（只读：这里只是看，不在改）">
          <Table
            records={agents}
            recordKey="agent_source"
            columns={[
              { key: 'agent_source', header: 'Agent', render: (r: SupportedAgent) => r.agent_source },
              { key: 'display_name', header: '名称', render: (r: SupportedAgent) => r.display_name },
              {
                key: 'protocol',
                header: '协议',
                render: (r: SupportedAgent) => PROTOCOL_LABEL[r.protocol] ?? r.protocol,
              },
              {
                key: 'group',
                header: '生效分组',
                render: (r: SupportedAgent) => {
                  const g = agentBinding.get(r.agent_source);
                  if (!g) return <Text theme="weak">未配置（走全局上游）</Text>;
                  return (
                    <Badge theme={g.group_type === 'custom' ? 'success' : 'default'}>
                      {g.name}
                    </Badge>
                  );
                },
              },
              {
                key: 'model',
                header: '模型 / 供应商',
                render: (r: SupportedAgent) => {
                  const g = agentBinding.get(r.agent_source);
                  if (!g) return '-';
                  const gModels = g.model_ids ?? (g.model_id ? [g.model_id] : []);
                  return (
                    <div>
                      <div>{gModels[0] || '（沿用请求里的 model）'}</div>
                      <Text theme="weak">{g.base_url || '-'}</Text>
                    </div>
                  );
                },
              },
              {
                key: 'key',
                header: 'Key',
                render: (r: SupportedAgent) => {
                  const g = agentBinding.get(r.agent_source);
                  if (!g) return '-';
                  if (g.mode === 'custom_passthrough') return <Text theme="weak">透传客户端 Key</Text>;
                  const masked = g.api_key || g.api_key_masked || '';
                  return <Text>{masked || '-'}</Text>;
                },
              },
            ]}
            addons={[autotip({ isLoading: loading, emptyText: '暂无 Agent' })]}
          />
        </Card.Body>
      </Card>

      <Modal visible={modalOpen} caption={editing ? '编辑上游分组' : '新增上游分组'} onClose={closeModal} size="l">
        <Modal.Body>
          <Form>
            <Form.Item label="分组名称">
              <Input
                value={form.name}
                onChange={(value) => setForm({ ...form, name: value })}
                placeholder="例如：我的 DeepSeek"
              />
            </Form.Item>
            <Form.Item label="生效 Agent">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {agents.map((a) => (
                  <Checkbox
                    key={a.agent_source}
                    value={form.agents.includes(a.agent_source)}
                    onChange={() => {
                      const checked = !form.agents.includes(a.agent_source);
                      setForm({
                        ...form,
                        agents: checked
                          ? [...form.agents, a.agent_source]
                          : form.agents.filter((x) => x !== a.agent_source),
                      });
                    }}
                  >
                    {a.display_name}（{a.agent_source}）
                  </Checkbox>
                ))}
                {agents.length === 0 ? <Text theme="weak">加载中…</Text> : null}
              </div>
            </Form.Item>
            <Form.Item label="生效团队">
              {editing ? (
                <Text>{form.team_id ? `团队专属（${form.team_id}）` : '全局（所有团队）'}</Text>
              ) : (
                <Select
                  appearance="button"
                  options={[
                    { value: '', text: '全局（所有团队，优先级最低）' },
                    ...teams.map((t) => ({ value: t.team_id, text: `团队专属 · ${t.name}` })),
                  ]}
                  value={form.team_id}
                  onChange={(value) => setForm({ ...form, team_id: value as string })}
                />
              )}
            </Form.Item>
            <Form.Item label="模式" style={hideIfDefault}>
              <Select
                appearance="button"
                options={[
                  { value: 'custom_unified', text: '自定义（统一 Key）' },
                  { value: 'custom_passthrough', text: '自定义（透传客户端 Key）' },
                ]}
                value={form.mode}
                onChange={(value) => setForm({ ...form, mode: value as FormState['mode'] })}
              />
            </Form.Item>
            <Form.Item label="供应商地址">
              <Input
                value={form.base_url}
                onChange={(value) => setForm({ ...form, base_url: value })}
                placeholder={isDefaultGroup ? '留空 = 沿用部署时配置的供应商' : 'https://api.example.com/v1'}
              />
            </Form.Item>
            <Form.Item label="API Key">
              <Input
                value={form.api_key}
                onChange={(value) => setForm({ ...form, api_key: value })}
                placeholder={isDefaultGroup ? '留空 = 沿用部署时配置的 Key' : 'sk-...'}
              />
            </Form.Item>
            <Form.Item label="模型清单">
              <div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                  {form.model_ids.length === 0 ? (
                    <Text theme="weak">未配置 = 沿用请求里的 model；配置后客户端只能选用清单内模型，第一个为默认</Text>
                  ) : (
                    form.model_ids.map((m, i) => (
                      <Badge key={m} theme={i === 0 ? 'success' : 'default'}>
                        {i === 0 ? '默认 · ' : ''}
                        {m}
                        <a
                          style={{ marginLeft: 6, cursor: 'pointer' }}
                          onClick={() =>
                            setForm({ ...form, model_ids: form.model_ids.filter((x) => x !== m) })
                          }
                        >
                          ×
                        </a>
                      </Badge>
                    ))
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Input
                    value={form.modelInput}
                    onChange={(value) => setForm({ ...form, modelInput: value })}
                    placeholder="手动输入模型 ID"
                    style={{ width: 220 }}
                  />
                  <Button
                    onClick={() => {
                      const id = form.modelInput.trim();
                      if (!id || form.model_ids.includes(id)) return;
                      setForm({ ...form, model_ids: [...form.model_ids, id], modelInput: '' });
                    }}
                  >
                    添加
                  </Button>
                  <Button type="primary" onClick={() => void fetchModels()}>
                    从供应商获取
                  </Button>
                </div>
              </div>
            </Form.Item>
            <Form.Item label="测试协议" style={hideIfDefault}>
              <Select
                appearance="button"
                options={[
                  { value: 'openai-chat', text: 'OpenAI Chat' },
                  { value: 'anthropic', text: 'Anthropic' },
                  { value: 'openai-responses', text: 'OpenAI Responses' },
                ]}
                value={form.protocol}
                onChange={(value) => setForm({ ...form, protocol: value as string })}
              />
            </Form.Item>
            <Form.Item label="启用">
              <Switch
                value={form.enabled}
                onChange={(value) => setForm({ ...form, enabled: value })}
              />
            </Form.Item>
          </Form>

          <div style={{ marginTop: 8 }}>
            <Button onClick={() => void test()} loading={testing}>
              测试连通性
            </Button>
            {testResult ? (
              <Alert
                type={testResult.ok ? 'success' : 'error'}
                style={{ marginTop: 12, wordBreak: 'break-all' }}
              >
                <div>
                  {testResult.ok ? '连接成功' : '连接失败'} · HTTP {testResult.status} ·{' '}
                  {testResult.latencyMs}ms
                </div>
                {testResult.modelEcho ? <div>上游回显模型：{testResult.modelEcho}</div> : null}
                {testResult.requestUrl ? <div>请求地址：{testResult.requestUrl}</div> : null}
                <div>响应：{testResult.responsePreview || '（空）'}</div>
              </Alert>
            ) : null}
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button type="primary" onClick={() => void save()} loading={saving}>
            保存
          </Button>
          <Button onClick={closeModal}>取消</Button>
        </Modal.Footer>
      </Modal>

      <ModelPickerModal
        visible={pickerVisible}
        models={pickerModels}
        loading={pickerLoading}
        error={pickerError}
        multiple
        initialSelected={form.model_ids}
        onClose={() => setPickerVisible(false)}
        onConfirm={(picked) => {
          // 已选在前（保持原顺序），新选在后
          const merged = [...form.model_ids.filter((m) => picked.includes(m))];
          for (const m of picked) if (!merged.includes(m)) merged.push(m);
          setForm({ ...form, model_ids: merged });
          setPickerVisible(false);
        }}
      />
    </div>
  );
}
