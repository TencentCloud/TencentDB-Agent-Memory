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
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Switch,
  Text,
  Tag,
  Modal,
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

type SettingsTab = 'permissions';

// 每个开关一条状态记录：值、状态、失败原因放在一起，互斥状态由联合类型约束。
// saving 带 requestId，用于丢弃过期响应；failed 带上失败原因，只显示在对应开关上。
type SwitchState =
  | { status: 'idle'; value: boolean }
  | { status: 'saving'; value: boolean; requestId: number }
  | { status: 'failed'; value: boolean; error: string; requestId: number };

function initialSwitches(): Record<string, SwitchState> {
  return Object.fromEntries(
    RESOURCE_MODULES.map((mod) => [mod.id, { status: 'idle', value: true } as SwitchState]),
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const activeTab: SettingsTab = 'permissions';

  const [switches, setSwitches] = useState<Record<string, SwitchState>>(initialSwitches);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const requestSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    userConfigApi.getAssetCapabilities()
      .then((cfg) => {
        if (cancelled) return;
        setSwitches((prev) => {
          const next = { ...prev };
          for (const mod of RESOURCE_MODULES) {
            // 加载结果不覆盖仍在保存中的开关。
            if (next[mod.id].status === 'saving') continue;
            next[mod.id] = { status: 'idle', value: cfg[mod.paramKey] };
          }
          return next;
        });
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  async function handleToggle(mod: ResourceModule, next: boolean) {
    const record = switches[mod.id];
    // 同一开关还在保存中时拒绝重复提交。
    if (record.status === 'saving') return;
    const requestId = ++requestSeq.current;
    const previousValue = record.value;
    setSwitches((prev) => ({
      ...prev,
      [mod.id]: { status: 'saving', value: next, requestId },
    }));
    try {
      await userConfigApi.setAssetCapability(mod.paramKey, next);
      setSwitches((prev) => {
        const current = prev[mod.id];
        // 只接受本次请求的响应，过期响应不写状态。
        if (current.status !== 'saving' || current.requestId !== requestId) return prev;
        return { ...prev, [mod.id]: { status: 'idle', value: next } };
      });
      tea.notify.success(t(next ? 'settings.notify.enabled' : 'settings.notify.disabled', { label: t(mod.labelKey) }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSwitches((prev) => {
        const current = prev[mod.id];
        if (current.status !== 'saving' || current.requestId !== requestId) return prev;
        // 失败只回滚本次请求写入的值，失败原因留在对应开关上。
        return { ...prev, [mod.id]: { status: 'failed', value: previousValue, error: msg, requestId } };
      });
      tea.notify.error(t('settings.notify.saveFailed', { msg }));
    }
  }

  return (
    <Modal visible caption={t('settings.caption')} size="m" onClose={onClose}>
      <Modal.Body>
      {activeTab === 'permissions' && (
        <div>
          <div style={{ paddingTop: 4 }}>
            <Text theme="label" style={{ display: 'block', marginBottom: 8 }}>
              {t('settings.title')}
            </Text>
            <Text theme="weak" style={{ display: 'block', marginBottom: 16, fontSize: 12 }}>
              {t('settings.desc')}
            </Text>
            {loadError && <Alert type="error" style={{ marginBottom: 12 }}>{loadError}</Alert>}
            {loading && <Alert type="info" style={{ marginBottom: 12 }}>{t('settings.loadingConfig')}</Alert>}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {RESOURCE_MODULES.map((mod) => {
                const record = switches[mod.id];
                const isSaving = record.status === 'saving';
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
                      background: record.value
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
                          {isSaving ? (
                            <Tag theme="warning" variant="soft" size="sm">{t('settings.tag.saving')}</Tag>
                          ) : record.value ? (
                            <Tag theme="success" variant="soft" size="sm">{t('settings.tag.enabled')}</Tag>
                          ) : (
                            <Tag theme="default" variant="soft" size="sm">{t('settings.tag.disabled')}</Tag>
                          )}
                        </div>
                        <Text theme="weak" style={{ fontSize: 12, marginTop: 2, display: 'block' }}>
                          {t(mod.descKey)}
                        </Text>
                        {record.status === 'failed' && (
                          <Text theme="danger" style={{ fontSize: 12, marginTop: 2, display: 'block' }}>
                            {record.error}
                          </Text>
                        )}
                      </div>
                    </div>
                    <Switch
                      value={record.value}
                      disabled={loading || isSaving}
                      onChange={(v) => void handleToggle(mod, v)}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
      </Modal.Body>
    </Modal>
  );
}
