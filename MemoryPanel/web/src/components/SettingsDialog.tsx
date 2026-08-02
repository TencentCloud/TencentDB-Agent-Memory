/**
 * SettingsDialog — 全局设置弹窗（从顶栏⚙图标触发）。
 *
 * 当前只有一个 Tab：「权限管理」— 控制资源管理模块的开关
 * （Wiki / Code / Skill / Chat_Memory），防止未稳定使用的模块
 * 被注入内核运行。
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
  Form,
  RadioGroup,
  Radio,
} from 'tea-component';
import {
  BooksIcon,
  CodeIcon,
  ToolsIcon,
  ChatIcon,
} from 'tea-icons-react';
import { userConfigApi, type AssetCapabilityKey } from '@/lib/teamApi';
import { tea } from '@/lib/tea-bridge';

// ===== 资源模块 =====

interface ResourceModule {
  id: string;
  paramKey: AssetCapabilityKey;
  labelKey: string;
  defaultLabel: string;
  descKey: string;
  defaultDesc: string;
  icon: JSX.Element;
}

const RESOURCE_MODULES: ResourceModule[] = [
  {
    id: 'wiki',
    paramKey: 'llm_wiki.enabled',
    labelKey: 'nav.items.wiki',
    defaultLabel: 'Wiki 知识库',
    descKey: 'common.wikiDesc',
    defaultDesc: '关闭后仅停止工具注入',
    icon: <BooksIcon size={16} />,
  },
  {
    id: 'code',
    paramKey: 'code_graph.enabled',
    labelKey: 'nav.items.code',
    defaultLabel: 'Code_Graph',
    descKey: 'common.codeDesc',
    defaultDesc: '关闭后仅停止工具注入',
    icon: <CodeIcon size={16} />,
  },
  {
    id: 'skill',
    paramKey: 'skill.enabled',
    labelKey: 'nav.items.skills',
    defaultLabel: 'Skill 技能',
    descKey: 'common.skillDesc',
    defaultDesc: '关闭后工具注入与新技能抽取均停止',
    icon: <ToolsIcon size={16} />,
  },
  {
    id: 'chat_memory',
    paramKey: 'chat_memory.enabled',
    labelKey: 'nav.items.chat_memory',
    defaultLabel: 'Chat_Memory',
    descKey: 'common.memoryDesc',
    defaultDesc: '关闭后工具注入与新对话写入均停止',
    icon: <ChatIcon size={16} />,
  },
];

type SettingsTab = 'permissions';

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const activeTab: SettingsTab = 'permissions';

  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => ({
    wiki: true,
    code: true,
    skill: true,
    chat_memory: true,
  }));
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<AssetCapabilityKey | null>(null);
  const [error, setError] = useState('');

  const currentLang = i18n.language.startsWith('zh') ? 'zh' : 'en';

  const handleLanguageChange = (lang: string) => {
    i18n.changeLanguage(lang);
  };

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
    const modLabel = t(mod.labelKey as any, { defaultValue: mod.defaultLabel });
    try {
      await userConfigApi.setAssetCapability(mod.paramKey, next);
      tea.notify.success(`${modLabel} ${next ? t('common.enabled', { defaultValue: '已开启' }) : t('common.disabled', { defaultValue: '已关闭' })}`);
    } catch (e) {
      setEnabled((prev) => ({ ...prev, [mod.id]: previous }));
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      tea.notify.error(`${t('common.failed', { defaultValue: '保存失败' })}: ${msg}`);
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <Modal visible caption={t('settings.title', { defaultValue: '系统设置' })} size="m" onClose={onClose}>
      <Modal.Body>
      {activeTab === 'permissions' && (
        <div>
          <div style={{ paddingTop: 4 }}>
            <Form.Item label={t('settings.languageLabel', { defaultValue: '语言 / Language' })}>
              <RadioGroup value={currentLang} onChange={handleLanguageChange}>
                <Radio name="zh">简体中文</Radio>
                <Radio name="en">English</Radio>
              </RadioGroup>
            </Form.Item>

            <div style={{ marginTop: 20 }}>
              <Text theme="label" style={{ display: 'block', marginBottom: 8 }}>
                {t('settings.resourceModules', { defaultValue: '资源管理模块开关' })}
              </Text>
              <Text theme="weak" style={{ display: 'block', marginBottom: 16, fontSize: 12 }}>
                {t('settings.resourceHint', { defaultValue: '开关按当前登录用户保存。关闭后，proxy 不会为该用户注入对应原子能力；变更对新会话即时生效。' })}
              </Text>
              {error && <Alert type="error" style={{ marginBottom: 12 }}>{error}</Alert>}
              {loading && <Alert type="info" style={{ marginBottom: 12 }}>{t('common.loading', { defaultValue: '正在读取当前用户资源配置…' })}</Alert>}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {RESOURCE_MODULES.map((mod) => {
                  const modLabel = t(mod.labelKey as any, { defaultValue: mod.defaultLabel });
                  return (
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
                              {modLabel}
                            </Text>
                            {savingKey === mod.paramKey ? (
                              <Tag theme="warning" variant="soft" size="sm">{t('common.saving', { defaultValue: '保存中' })}</Tag>
                            ) : enabled[mod.id] ? (
                              <Tag theme="success" variant="soft" size="sm">{t('common.enabledTag', { defaultValue: '已开启' })}</Tag>
                            ) : (
                              <Tag theme="default" variant="soft" size="sm">{t('common.disabledTag', { defaultValue: '已关闭' })}</Tag>
                            )}
                          </div>
                        </div>
                      </div>
                      <Switch
                        value={enabled[mod.id]}
                        disabled={loading || savingKey === mod.paramKey}
                        onChange={(v) => void handleToggle(mod, v)}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
      </Modal.Body>
    </Modal>
  );
}
