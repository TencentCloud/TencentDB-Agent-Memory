/**
 * SettingsDialog — 全局设置弹窗（从顶栏⚙图标触发）。
 *
 * 目前两个 Tab：
 *   - 「权限管理」：控制资源管理模块的开关（Wiki / Code / Skill / Chat_Memory），
 *     防止未稳定使用的模块被注入内核运行。
 *   - 「上游 LLM」：让用户配置自己转发到上游 LLM 的 API Key（存于内核
 *     `llm.api_key` config param，按当前登录用户保存）。proxy 转发该用户的
 *     请求时只使用此 Key 作为上游服务端 Key，不回落到代理全局 / Agent Key。
 *
 * 后续可在 TABS 数组里追加其他 Tab（如通知、偏好设置等）。
 *
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Switch,
  Text,
  Tag,
  Modal,
  Input,
  Button,
  Form,
} from 'tea-component';
import {
  BooksIcon,
  CodeIcon,
  ToolsIcon,
  ChatIcon,
} from 'tea-icons-react';
import { userConfigApi, type AssetCapabilityKey } from '@/lib/teamApi';
import { getCurrentUser } from '@/lib/api/base';
import { tea } from '@/lib/tea-bridge';

// ===== 资源模块 =====

interface ResourceModule {
  id: string;
  paramKey: AssetCapabilityKey;
  labelKey: string;
  descKey: string;
  icon: JSX.Element;
}

const RESOURCE_MODULES: ResourceModule[] = [
  {
    id: 'wiki',
    paramKey: 'llm_wiki.enabled',
    labelKey: 'settings.module.wiki',
    descKey: 'settings.module.wiki.desc',
    icon: <BooksIcon size={16} />,
  },
  {
    id: 'code',
    paramKey: 'code_graph.enabled',
    labelKey: 'settings.module.code',
    descKey: 'settings.module.code.desc',
    icon: <CodeIcon size={16} />,
  },
  {
    id: 'skill',
    paramKey: 'skill.enabled',
    labelKey: 'settings.module.skill',
    descKey: 'settings.module.skill.desc',
    icon: <ToolsIcon size={16} />,
  },
  {
    id: 'chat_memory',
    paramKey: 'chat_memory.enabled',
    labelKey: 'settings.module.chatMemory',
    descKey: 'settings.module.chatMemory.desc',
    icon: <ChatIcon size={16} />,
  },
];

type SettingsTab = 'permissions' | 'upstream';

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<SettingsTab>('permissions');

  // ===== Tab 1: 权限管理 =====
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => ({
    wiki: true,
    code: true,
    skill: true,
    chat_memory: true,
  }));
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<AssetCapabilityKey | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    userConfigApi.getAssetCapabilities()
      .then((cfg) => {
        if (cancelled) return;
        setEnabled({
          wiki: cfg['llm_wiki.enabled'],
          code: cfg['code_graph.enabled'],
          skill: cfg['skill.enabled'],
          chat_memory: cfg['chat_memory.enabled'],
        });
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  async function handleToggle(mod: ResourceModule, next: boolean) {
    const previous = enabled[mod.id];
    setEnabled((prev) => ({ ...prev, [mod.id]: next }));
    setSavingKey(mod.paramKey);
    setError('');
    try {
      await userConfigApi.setAssetCapability(mod.paramKey, next);
      tea.notify.success(t(next ? 'settings.notify.enabled' : 'settings.notify.disabled', { label: t(mod.labelKey) }));
    } catch (e) {
      setEnabled((prev) => ({ ...prev, [mod.id]: previous }));
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      tea.notify.error(t('settings.notify.saveFailed', { msg }));
    } finally {
      setSavingKey(null);
    }
  }

  // ===== Tab 2: 上游 LLM（按当前登录用户保存） =====
  const [upstreamLoading, setUpstreamLoading] = useState(true);
  const [upstreamSaving, setUpstreamSaving] = useState(false);
  const [upstreamKey, setUpstreamKey] = useState('');
  const [upstreamInitKey, setUpstreamInitKey] = useState('');
  const [upstreamError, setUpstreamError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setUpstreamLoading(true);
    setUpstreamError('');
    (async () => {
      try {
        const me = await getCurrentUser();
        const view = await userConfigApi.get(me.user_id, 'llm', 'api_key');
        if (cancelled) return;
        const val = view.items?.[0]?.effective_value ?? '';
        setUpstreamKey(val);
        setUpstreamInitKey(val);
      } catch (e) {
        if (!cancelled) setUpstreamError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setUpstreamLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function handleSaveUpstream() {
    setUpstreamSaving(true);
    setUpstreamError('');
    try {
      const me = await getCurrentUser();
      await userConfigApi.set(me.user_id, 'llm', { api_key: upstreamKey.trim() });
      setUpstreamInitKey(upstreamKey.trim());
      tea.notify.success(t('settings.upstream.saved'));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setUpstreamError(msg);
      tea.notify.error(t('settings.notify.saveFailed', { msg }));
    } finally {
      setUpstreamSaving(false);
    }
  }

  async function handleClearUpstream() {
    setUpstreamSaving(true);
    setUpstreamError('');
    try {
      const me = await getCurrentUser();
      await userConfigApi.set(me.user_id, 'llm', { api_key: '' });
      setUpstreamKey('');
      setUpstreamInitKey('');
      tea.notify.success(t('settings.upstream.saved'));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setUpstreamError(msg);
      tea.notify.error(t('settings.notify.saveFailed', { msg }));
    } finally {
      setUpstreamSaving(false);
    }
  }

  const tabBtn = (id: SettingsTab, labelKey: string) => (
    <button
      type="button"
      onClick={() => setActiveTab(id)}
      style={{
        padding: '6px 16px',
        border: '1px solid var(--tea-color-border-primary-default)',
        borderRadius: 6,
        background: activeTab === id
          ? 'var(--tea-color-bg-brand-lighten-default)'
          : 'var(--tea-color-bg-primary-default)',
        color: 'var(--tea-color-text-primary)',
        fontWeight: activeTab === id ? 600 : 400,
        cursor: 'pointer',
      }}
    >
      {t(labelKey)}
    </button>
  );

  return (
    <Modal visible caption={t('settings.caption')} size="m" onClose={onClose}>
      <Modal.Body>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {tabBtn('permissions', 'settings.tab.permissions')}
          {tabBtn('upstream', 'settings.tab.upstream')}
        </div>

        {activeTab === 'permissions' && (
          <div>
            <div style={{ paddingTop: 4 }}>
              <Text theme="label" style={{ display: 'block', marginBottom: 8 }}>
                {t('settings.title')}
              </Text>
              <Text theme="weak" style={{ display: 'block', marginBottom: 16, fontSize: 12 }}>
                {t('settings.desc')}
              </Text>
              {error && <Alert type="error" style={{ marginBottom: 12 }}>{error}</Alert>}
              {loading && <Alert type="info" style={{ marginBottom: 12 }}>{t('settings.loadingConfig')}</Alert>}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {RESOURCE_MODULES.map((mod) => (
                  <div
                    key={mod.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 12px',
                      border: '1px solid var(--tea-color-border-primary-default)',
                      borderRadius: 6,
                      background: enabled[mod.id]
                        ? 'var(--tea-color-bg-brand-lighten-default)'
                        : 'var(--tea-color-bg-primary-default)',
                      transition: 'background-color 0.15s',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                      <span style={{ color: 'var(--tea-color-text-secondary)', flexShrink: 0 }}>
                        {mod.icon}
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <Text style={{ fontSize: 13, fontWeight: 500 }}>
                            {t(mod.labelKey)}
                          </Text>
                          {savingKey === mod.paramKey ? (
                            <Tag theme="warning" variant="soft" size="sm">{t('settings.tag.saving')}</Tag>
                          ) : enabled[mod.id] ? (
                            <Tag theme="success" variant="soft" size="sm">{t('settings.tag.enabled')}</Tag>
                          ) : (
                            <Tag theme="default" variant="soft" size="sm">{t('settings.tag.disabled')}</Tag>
                          )}
                        </div>
                        <Text theme="weak" style={{ fontSize: 12, marginTop: 2, display: 'block' }}>
                          {t(mod.descKey)}
                        </Text>
                      </div>
                    </div>
                    <Switch
                      value={enabled[mod.id]}
                      disabled={loading || savingKey === mod.paramKey}
                      onChange={(v) => void handleToggle(mod, v)}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'upstream' && (
          <div>
            <div style={{ paddingTop: 4 }}>
              <Text theme="label" style={{ display: 'block', marginBottom: 8 }}>
                {t('settings.upstream.title')}
              </Text>
              <Text theme="weak" style={{ display: 'block', marginBottom: 16, fontSize: 12 }}>
                {t('settings.upstream.desc')}
              </Text>
              {upstreamError && <Alert type="error" style={{ marginBottom: 12 }}>{upstreamError}</Alert>}
              {upstreamLoading && <Alert type="info" style={{ marginBottom: 12 }}>{t('settings.upstream.loading')}</Alert>}

              <Form layout="vertical" style={{ maxWidth: 480 }}>
                <Form.Item
                  label={t('settings.upstream.keyLabel')}
                  extra={
                    <span>
                      <a
                        href="https://tencent.sso.codebuddy.cn/profile/keys"
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t('settings.upstream.keyLink')}
                      </a>
                      {t('settings.upstream.keyExtra')}
                    </span>
                  }
                >
                  <Input
                    value={upstreamKey}
                    onChange={(v) => setUpstreamKey(v)}
                    placeholder={t('settings.upstream.keyPlaceholder')}
                    type="password"
                    disabled={upstreamLoading}
                  />
                </Form.Item>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <Button
                    type="primary"
                    onClick={() => void handleSaveUpstream()}
                    loading={upstreamSaving}
                    disabled={upstreamLoading || upstreamKey.trim() === upstreamInitKey}
                  >
                    {t('settings.upstream.save')}
                  </Button>
                  <Button
                    onClick={() => void handleClearUpstream()}
                    loading={upstreamSaving}
                    disabled={upstreamLoading || upstreamInitKey === ''}
                  >
                    {t('settings.upstream.clear')}
                  </Button>
                </div>
              </Form>
            </div>
          </div>
        )}
      </Modal.Body>
    </Modal>
  );
}
