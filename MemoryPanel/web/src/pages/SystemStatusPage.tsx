/**
 * SystemStatusPage — 菜单 3「系统状态」。
 *
 * 三个功能：
 *   5. 健康看板：core / proxy / knowledge / redis / 计费上报 / 用量统计各自是绿是红
 *   6. 当前配置一览：生效中的配置（脱敏）汇总一页
 *   ＋ 用量统计：把「自定义上游」这一项的贡献单列出来
 *
 * ── 关于「自定义上游」这一项的计算口径 ────────────────────────────────────
 *   参与环节：仅**用量统计**，不参与平台计费。
 *   原因：自定义上游的 Key 由用户自备，费用用户自付，平台不出账。
 *   展示的「等价 Credit」= 按平台价目表折算的参考值（"若走官方通道要花多少"），
 *   **不是账单金额**，不能与已上报的 CreditDelta 相加。
 */
import { useCallback, useEffect, useState } from 'react';
import { Card, Button, Alert, Text, Justify, H3, Badge, Table } from 'tea-component';
import {
  systemApi,
  type ComponentHealth,
  type ConfigSection,
  type UsageResult,
} from '@/lib/api/system';

const { autotip } = Table.addons;

const STATUS_THEME: Record<string, 'success' | 'warning' | 'danger' | 'default'> = {
  ok: 'success',
  warn: 'warning',
  down: 'danger',
  unknown: 'default',
};

const STATUS_TEXT: Record<string, string> = {
  ok: '正常',
  warn: '告警',
  down: '不可用',
  unknown: '未知',
};

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString('zh-CN') : '-';
}

export function SystemStatusPage() {
  const [checks, setChecks] = useState<ComponentHealth[]>([]);
  const [usage, setUsage] = useState<UsageResult | null>(null);
  const [sections, setSections] = useState<ConfigSection[]>([]);
  const [generatedAt, setGeneratedAt] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showConfig, setShowConfig] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [health, usageData] = await Promise.all([systemApi.health(), systemApi.usage()]);
      setChecks(health.checks ?? []);
      setGeneratedAt(health.generatedAt ?? '');
      setUsage(usageData);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadConfig = async () => {
    if (showConfig) {
      setShowConfig(false);
      return;
    }
    try {
      const data = await systemApi.config();
      setSections(data.sections ?? []);
      setShowConfig(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const totals = usage?.totals;

  return (
    <div style={{ padding: 20 }}>
      <Justify
        left={
          <div>
            <H3>系统状态</H3>
            <Text theme="weak">
              各组件健康与用量概览{generatedAt ? ` · 采集于 ${new Date(generatedAt).toLocaleString('zh-CN')}` : ''}
            </Text>
          </div>
        }
        right={<Button onClick={() => void refresh()}>刷新</Button>}
      />

      {error ? (
        <Alert type="error" style={{ marginTop: 12 }}>
          {error}
        </Alert>
      ) : null}

      {/* 5. 健康看板 */}
      <Card style={{ marginTop: 16 }}>
        <Card.Body title="健康看板">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {checks.map((c) => (
              <div
                key={c.name}
                style={{
                  border: '1px solid #e5e5e5',
                  borderRadius: 6,
                  padding: '10px 14px',
                  minWidth: 200,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <b>{c.name}</b>
                  <Badge theme={STATUS_THEME[c.status] ?? 'default'}>{STATUS_TEXT[c.status] ?? c.status}</Badge>
                </div>
                <Text theme="weak" style={{ display: 'block', marginTop: 6, wordBreak: 'break-all' }}>
                  {c.detail}
                </Text>
                {typeof c.latencyMs === 'number' ? (
                  <Text theme="weak" style={{ display: 'block', marginTop: 2 }}>
                    {c.latencyMs}ms
                  </Text>
                ) : null}
              </div>
            ))}
            {checks.length === 0 && !loading ? <Text theme="weak">暂无数据</Text> : null}
          </div>
        </Card.Body>
      </Card>

      {/* 用量统计 —— 把「自定义上游」这一项的贡献单列 */}
      <Card style={{ marginTop: 16 }}>
        <Card.Body title="用量统计 · 自定义上游（用户自付）">
          <Alert type="info">
            {usage?.note ??
              '自定义上游用量统计。等价 Credit 是按平台价目表折算的参考值，不计入平台账单。'}
            <br />
            <b>不纳入平台计费</b>
            {usage ? `（billedToPlatform=${String(usage.billedToPlatform)}）` : ''}
            ：这部分流量用的是你自己的 Key，平台不出账，所以不会出现在账单里；这里单列是为了让它的用量可见。
          </Alert>

          {totals ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, margin: '16px 0' }}>
              <div>
                <Text theme="weak">请求数</Text>
                <div style={{ fontSize: 20 }}>{fmt(totals.requests)}</div>
              </div>
              <div>
                <Text theme="weak">输入 token</Text>
                <div style={{ fontSize: 20 }}>{fmt(totals.input)}</div>
              </div>
              <div>
                <Text theme="weak">输出 token</Text>
                <div style={{ fontSize: 20 }}>{fmt(totals.output)}</div>
              </div>
              <div>
                <Text theme="weak">缓存读</Text>
                <div style={{ fontSize: 20 }}>{fmt(totals.cacheRead)}</div>
              </div>
              <div>
                <Text theme="weak">等价 Credit（参考）</Text>
                <div style={{ fontSize: 20 }}>{totals.equivalentCredit.toFixed(4)}</div>
              </div>
              <div>
                <Text theme="weak">未登记价目的 token</Text>
                <div style={{ fontSize: 20 }}>{fmt(totals.unpricedTokens)}</div>
              </div>
            </div>
          ) : null}

          <Table
            records={usage?.items ?? []}
            recordKey={(r: UsageResult['items'][number]) => `${r.spaceId}|${r.agent}|${r.groupId}|${r.model}|${r.teamId ?? ''}`}
            columns={[
              { key: 'agent', header: 'Agent', render: (r: UsageResult['items'][number]) => r.agent },
              { key: 'groupName', header: '分组', render: (r: UsageResult['items'][number]) => r.groupName },
              {
                key: 'teamId',
                header: '团队',
                render: (r: UsageResult['items'][number]) => (r.teamId ? r.teamId : '全局'),
              },
              { key: 'model', header: '模型', render: (r: UsageResult['items'][number]) => r.model },
              {
                key: 'requests',
                header: '请求数',
                render: (r: UsageResult['items'][number]) => fmt(r.requests),
              },
              { key: 'input', header: '输入', render: (r: UsageResult['items'][number]) => fmt(r.input) },
              { key: 'output', header: '输出', render: (r: UsageResult['items'][number]) => fmt(r.output) },
              {
                key: 'cacheRead',
                header: '缓存读',
                render: (r: UsageResult['items'][number]) => fmt(r.cacheRead),
              },
              {
                key: 'equivalentCredit',
                header: '等价 Credit',
                render: (r: UsageResult['items'][number]) => r.equivalentCredit.toFixed(4),
              },
              {
                key: 'lastAt',
                header: '最近一次',
                render: (r: UsageResult['items'][number]) =>
                  r.lastAt ? new Date(r.lastAt).toLocaleString('zh-CN') : '-',
              },
            ]}
            addons={[
              autotip({
                isLoading: loading,
                emptyText: '暂无自定义上游用量（进程重启后清零）',
              }),
            ]}
          />
        </Card.Body>
      </Card>

      {/* 6. 当前配置一览 */}
      <Card style={{ marginTop: 16 }}>
        <Card.Body title="当前配置一览（脱敏）">
          <Button onClick={() => void loadConfig()}>{showConfig ? '收起' : '查看'}</Button>
          {showConfig ? (
            <div style={{ marginTop: 12 }}>
              {sections.map((s) => (
                <div key={s.source} style={{ marginBottom: 16 }}>
                  <b>{s.source === 'core' ? 'Memory Core 配置' : 'Memory Proxy 配置'}</b>
                  <Text theme="weak" style={{ display: 'block' }}>
                    {s.path}
                  </Text>
                  {s.exists ? (
                    <pre
                      style={{
                        background: '#f7f8fa',
                        padding: 12,
                        borderRadius: 4,
                        maxHeight: 420,
                        overflow: 'auto',
                        fontSize: 12,
                      }}
                    >
                      {String(s.data ?? '')}
                    </pre>
                  ) : (
                    <Alert type="warning">文件未挂载到面板容器，无法读取</Alert>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </Card.Body>
      </Card>
    </div>
  );
}
