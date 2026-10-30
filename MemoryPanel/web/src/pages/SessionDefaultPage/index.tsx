import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Alert, Button, Input, Modal, Select, Table } from 'tea-component';
import { metaPost, metaListAll, getCurrentUser } from '@/lib/api/base';

interface AgentRow { agent_id: string; name: string; team_id: string; status: string; }
interface Binding {
  user_id: string;
  workspace_id: string;
  team_id: string;
  agent_id: string;
  task_id: string;
  updated_at?: string;
}

const BRANDS: { value: string; text: string }[] = [
  { value: 'claude-code', text: 'claude-code' },
  { value: 'codebuddy', text: 'codebuddy' },
  { value: 'codex', text: 'codex' },
  { value: 'workbuddy', text: 'workbuddy' },
  { value: 'dsh', text: 'dsh' },
  { value: 'hermes', text: 'hermes' },
  { value: 'openclaw', text: 'openclaw' },
  { value: 'opencode', text: 'opencode' },
  { value: 'pi', text: 'pi' },
];

/** 每个品牌在用户端「可视化界面/命令行」里找会话 ID 的分步指引 */
const SESSION_TIPS: Record<string, string[]> = {
  'dsh': [
    '命令行方式：执行 ls ~/.dsh/sessions（Windows PowerShell：dir $env:USERPROFILE\\.dsh\\sessions），每个子目录名就是会话 ID。',
    '界面方式：dsh 会话窗口的标题栏/启动输出里会显示 session 标识，形如 8-16 位随机串或 UUID。',
  ],
  'claude-code': [
    '界面方式：在项目目录终端里运行 claude --resume（或在会话中输入 /resume），弹出的历史会话列表中每一行对应一个会话，其 UUID 即会话 ID。',
    '文件方式：打开 ~/.claude/projects/ 目录，进入与你项目对应的子目录（目录名是项目路径的改写形式），里面的 <UUID>.jsonl 文件名就是会话 ID。',
  ],
  'codebuddy': [
    '界面方式：打开 CodeBuddy 的 AI 助手面板 → 「历史会话」列表，点击对应会话后，从会话详情或浏览器/IDE 开发者工具（Network 面板）的请求地址中可以看到 sessionId 参数。',
    '文件方式：本机会话记录目录中的会话文件名/目录名即会话 ID。',
  ],
  'codex': [
    '界面方式：终端运行 codex resume，会话选择器会列出历史会话，选中项即对应一个会话 ID。',
    '文件方式：打开 ~/.codex/sessions/ 目录，文件名中包含的 UUID 即会话 ID。',
  ],
  'workbuddy': [
    '界面方式：WorkBuddy 桌面端左侧「历史会话」面板，点击进入对应会话；会话标识可在该会话的分享链接或详情中看到。',
    '文件方式：会话记录存放在 ~/.workbuddy/projects/<项目目录>/ 下的 .jsonl 文件（Windows：%USERPROFILE%\\.workbuddy\\projects\\），文件名含会话 ID。',
  ],
  'hermes': [
    'hermes 属于「纯 header」客户端（无交互表单），会话 ID 随请求自动发送，客户端界面通常不直接展示。',
  ],
  'openclaw': [
    'openclaw 属于「纯 header」客户端（无交互表单），会话 ID 随请求自动发送，客户端界面通常不直接展示。',
  ],
};

/** 通用兜底：从 proxy 日志反查会话 ID（最可靠，适用于所有品牌） */
const TIP_FALLBACK_STEPS: string[] = [
  '向该会话随便发一条消息（比如「hi」）。',
  'SSH 到 NAS 后执行：docker logs tdai-proxy 2>&1 | grep "session-init" | tail -5',
  '日志行里 session=<品牌>:<ID> 冒号后面的部分，就是你要填的会话 ID。',
  '注意：这段会话已经初始化过了，本次绑定对它不生效——绑定要用这个 ID 去绑「下一段新会话」时，请把 ID 换成新会话自己的 ID（每段会话 ID 不同）。',
];

const TIP_FALLBACK_NOTE =
  '以上路径都找不到时，用下面的「日志兜底法」最可靠：';

const STEP_TITLES = ['选择 Agent', '选择品牌', '绑定级别', '特征 ID', '确认', '完成'];

/** 自绘步骤条：走过的步与当前步高亮（蓝），未来步灰。 */
function StepBar({ current }: { current: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
      {STEP_TITLES.map((t, i) => {
        const done = i < current;
        const active = i === current;
        const circle: CSSProperties = {
          width: 26,
          height: 26,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 13,
          flexShrink: 0,
          border: '1px solid',
          background: done || active ? '#006eff' : 'var(--bg, #f5f5f5)',
          borderColor: done || active ? '#006eff' : 'var(--border, #ddd)',
          color: done || active ? '#fff' : 'var(--muted-foreground, #999)',
          fontWeight: active ? 600 : 400,
        };
        const label: CSSProperties = {
          fontSize: 12,
          marginLeft: 6,
          whiteSpace: 'nowrap',
          color: done || active ? '#006eff' : 'var(--muted-foreground, #999)',
          fontWeight: active ? 600 : 400,
        };
        const bar: CSSProperties = {
          flex: 1,
          height: 2,
          margin: '0 8px',
          background: done ? '#006eff' : 'var(--border, #ddd)',
        };
        return (
          <div key={t} style={{ display: 'flex', alignItems: 'center', flex: i === STEP_TITLES.length - 1 ? '0 0 auto' : 1 }}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <div style={circle}>{done ? '✓' : i + 1}</div>
              <span style={label}>{t}</span>
            </div>
            {i < STEP_TITLES.length - 1 && <div style={bar} />}
          </div>
        );
      })}
    </div>
  );
}

function resetWizardState(
  setStep: (n: number) => void,
  setAgentId: (s: string) => void,
  setBrand: (s: string) => void,
  setLevel: (l: 'arm' | 'session' | 'workspace') => void,
  setFeatureId: (s: string) => void,
): void {
  setStep(1);
  setAgentId('');
  setBrand('');
  setLevel('arm');
  setFeatureId('');
}

export function SessionDefaultPage() {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [rows, setRows] = useState<Binding[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [msgType, setMsgType] = useState<'success' | 'error'>('success');

  // 弹窗与向导状态
  const [wizardOpen, setWizardOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [agentId, setAgentId] = useState('');
  const [brand, setBrand] = useState('');
  const [level, setLevel] = useState<'arm' | 'session' | 'workspace'>('arm');
  const ARM_TTL = 24 * 3600 * 1000;
  const [featureId, setFeatureId] = useState('');

  const flash = (m: string, t: 'success' | 'error' = 'success') => {
    setMsg(m);
    setMsgType(t);
  };

  const refresh = useCallback(async () => {
    try {
      const me = await getCurrentUser();
      const result = await metaPost<Binding[] | { items?: Binding[] }>(
        'user-session-default/list',
        { user_id: me.user_id },
      );
      const items = Array.isArray(result) ? result : (result?.items ?? []);
      setRows(items);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), 'error');
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        // agent/list 不支持 user_id 过滤，按 team 遍历合并去重；
        // team/list schema 强制要求 user_id/user_key（v3-meta-schemas.ts teamListSchema）
        const me = await getCurrentUser();
        const teams = await metaListAll<{ team_id: string }>('team/list', { user_id: me.user_id });
        const seen = new Set<string>();
        const all: AgentRow[] = [];
        for (const t of teams) {
          const list = await metaListAll<AgentRow>('agent/list', { team_id: t.team_id });
          for (const a of list) {
            if (a.status !== 'inactive' && !seen.has(a.agent_id)) {
              seen.add(a.agent_id);
              all.push(a);
            }
          }
        }
        setAgents(all);
      } catch (e) {
        flash(e instanceof Error ? e.message : String(e), 'error');
      }
      await refresh();
    })();
  }, [refresh]);

  // URL query 预选 agent：存在且匹配则直接弹窗并跳过 Step 1
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('agent');
    if (!q) return;
    if (agents.some((a) => a.agent_id === q)) {
      setAgentId(q);
      setStep(2);
      setWizardOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents]);

  const selectedAgent = agents.find((a) => a.agent_id === agentId) || null;

  const workspaceIdValue =
    level === 'arm' ? `arm:${brand}:${Date.now() + ARM_TTL}`
    : level === 'session' ? `session:${featureId.trim()}`
    : featureId.trim();

  function closeWizard(): void {
    setWizardOpen(false);
    resetWizardState(setStep, setAgentId, setBrand, setLevel, setFeatureId);
  }

  async function confirmCreate() {
    if (!agentId || !selectedAgent || (level !== 'arm' && !featureId.trim()) || (level === 'workspace' && /^(arm|session):/.test(featureId.trim()))) {
      flash('参数不完整', 'error');
      return;
    }
    setBusy(true);
    try {
      const me = await getCurrentUser();
      await metaPost('user-session-default/set', {
        user_id: me.user_id,
        task_id: 'default',
        workspace_id: workspaceIdValue,
        team_id: selectedAgent.team_id,
        agent_id: agentId,
      });
      flash('绑定已创建');
      await refresh();
      setStep(6);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), 'error');
    }
    setBusy(false);
  }

  async function remove(ws: string) {
    if (!window.confirm(`确认删除绑定 ${ws}？`)) return;
    setBusy(true);
    try {
      const me = await getCurrentUser();
      await metaPost('user-session-default/delete', { user_id: me.user_id, workspace_id: ws });
      flash('已删除');
      await refresh();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), 'error');
    }
    setBusy(false);
  }

  const importCommand = selectedAgent
    ? `tsx agents/asset-import.ts --source ${brand} --agent-id ${selectedAgent.agent_id} --team-id ${selectedAgent.team_id}`
    : '';

  function legacyCopy(text: string): boolean {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  function copyCommand() {
    // 面板经 http 访问时 navigator.clipboard 不可用（非安全上下文），需降级 execCommand
    const text = importCommand;
    const done = () => flash('命令已复制');
    const fail = () => flash('复制失败，请手动选中命令复制', 'error');
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, () => (legacyCopy(text) ? done() : fail()));
    } else {
      legacyCopy(text) ? done() : fail();
    }
  }

  const agentName = (id: string): string => {
    const a = agents.find((x) => x.agent_id === id);
    return a ? a.name : id;
  };

  const armRows = rows.filter((r) => r.workspace_id.startsWith('arm:'));
  const wsRows = rows.filter((r) => !r.workspace_id.startsWith('session:') && !r.workspace_id.startsWith('arm:'));
  const sessionRows = rows.filter((r) => r.workspace_id.startsWith('session:'));

  const armRemain = (ws: string): string => {
    const parts = ws.split(':');
    const expiry = Number(parts[2]);
    if (!Number.isFinite(expiry)) return '-';
    const ms = expiry - Date.now();
    if (ms <= 0) return '即将过期';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return `${h} 小时 ${m} 分`;
  };

  // ---- 向导各步骤（渲染在弹窗内）----
  function renderStepBody() {
    if (step === 1) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>选择要把记忆绑定到哪个 Agent：</div>
          <Select
            value={agentId}
            onChange={(v) => setAgentId(v as string)}
            options={agents.map((a) => ({ value: a.agent_id, text: `${a.name} (${a.agent_id})` }))}
            placeholder="选择 Agent"
          />
          <div>
            <Button type="primary" disabled={!agentId} onClick={() => setStep(2)}>下一步</Button>
          </div>
        </div>
      );
    }
    if (step === 2) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>你用哪款客户端软件发起会话？</div>
          <Select
            value={brand}
            onChange={(v) => setBrand(v as string)}
            options={BRANDS}
            placeholder="选择品牌"
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={() => setStep(1)}>上一步</Button>
            <Button type="primary" disabled={!brand} onClick={() => setStep(3)}>下一步</Button>
          </div>
        </div>
      );
    }
    if (step === 3) {
      const cards: { id: 'arm' | 'session' | 'workspace'; title: string; desc: string }[] = [
        { id: 'arm', title: '🟢 绑定下一个新会话（推荐）', desc: '点确认后 24 小时内，你在该客户端新开的第一个会话将自动绑定，零配置。' },
        { id: 'session', title: '⌨️ 手动输入会话 ID', desc: '自己找到会话 ID 填入（下方有各品牌的查找指引）。' },
        { id: 'workspace', title: '🟡 绑定整个 workspace（高级）', desc: '该 workspace 下所有新会话归此 agent。需客户端发送 x-tdai-workspace-id，当前各家默认不发，绑了暂不生效。' },
      ];
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>选择绑定方式（对客户端 {brand}）：</div>
          {cards.map((c) => (
            <div
              key={c.id}
              onClick={() => setLevel(c.id)}
              style={{
                border: level === c.id ? '2px solid #006eff' : '1px solid var(--border, #ddd)',
                borderRadius: 8,
                padding: '10px 12px',
                cursor: 'pointer',
                background: level === c.id ? 'rgba(0,110,255,0.05)' : 'transparent',
              }}
            >
              <div style={{ fontWeight: 600 }}>{c.title}</div>
              <div style={{ fontSize: 12, color: 'var(--muted-foreground, #888)', marginTop: 4, lineHeight: 1.5 }}>{c.desc}</div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={() => setStep(2)}>上一步</Button>
            <Button type="primary" onClick={() => setStep(4)}>下一步</Button>
          </div>
        </div>
      );
    }
    if (step === 4) {
      if (level === 'arm') {
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ border: '1px solid #b8d4ff', borderRadius: 6, padding: 14, background: 'rgba(0,110,255,0.04)', fontSize: 13 }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>🟢 待命绑定模式——无需填任何 ID：</div>
              <div style={{ lineHeight: 1.8 }}>
                <div style={{ marginBottom: 6 }}>1. 点「确认创建」后，系统进入 24 小时待命状态。</div>
                <div style={{ marginBottom: 6 }}>2. 回到 {brand}，<b>新开一个会话</b>并随便发一条消息（比如「hi」）。</div>
                <div style={{ marginBottom: 6 }}>3. 该会话会<b>自动绑定</b>到所选 Agent，后续记忆自动归档，无需再做任何配置。</div>
                <div>4. 24 小时内未开新会话则待命自动失效，可随时重新创建。</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button onClick={() => setStep(3)}>上一步</Button>
              <Button type="primary" onClick={() => setStep(5)}>下一步</Button>
            </div>
          </div>
        );
      }
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>{level === 'session' ? '填写该品牌的会话 ID：' : '填写 workspace 标识：'}</div>
          <Input
            value={featureId}
            onChange={(v) => setFeatureId(v)}
            placeholder={level === 'session' ? '该品牌的会话 ID' : '自定字符串，如 nas / zimeiti'}
          />
          {level === 'workspace' && /^(arm|session):/.test(featureId.trim()) && (
            <div style={{ color: '#d83931', fontSize: 12 }}>
              ⚠️ workspace 标识不能以 <code>arm:</code> 或 <code>session:</code> 开头（系统保留前缀），请换一个名字。
            </div>
          )}
          {level === 'session' ? (
            <div style={{ border: '1px solid var(--border, #e0e0e0)', borderRadius: 6, padding: 12, background: 'var(--bg, #fafafa)', maxHeight: 260, overflowY: 'auto', fontSize: 13 }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>📍 在 {brand} 里哪里找会话 ID：</div>
              {(SESSION_TIPS[brand] || []).map((s, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  <span style={{ color: '#006eff', fontWeight: 600, flexShrink: 0 }}>{i + 1}.</span>
                  <span style={{ lineHeight: 1.6 }}>{s}</span>
                </div>
              ))}
              <div style={{ margin: '10px 0 6px', fontWeight: 600 }}>🧰 日志兜底法（所有品牌通用，最可靠）：</div>
              {TIP_FALLBACK_STEPS.map((s, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  <span style={{ color: '#e37318', fontWeight: 600, flexShrink: 0 }}>{i + 1}.</span>
                  <span style={{ lineHeight: 1.6, fontFamily: /docker|\\$|dir |ls /i.test(s) ? 'monospace' : 'inherit' }}>{s}</span>
                </div>
              ))}
              <div style={{ marginTop: 8, color: 'var(--muted-foreground, #888)', fontSize: 12 }}>{TIP_FALLBACK_NOTE}</div>
            </div>
          ) : (
            <div style={{ border: '1px solid var(--border, #e0e0e0)', borderRadius: 6, padding: 12, background: 'var(--bg, #fafafa)', fontSize: 13 }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>📍 workspace 标识的来源说明：</div>
              <div style={{ lineHeight: 1.7 }}>
                <div style={{ marginBottom: 6 }}>
                  1. workspace 标识<b>不是从客户端界面里找的</b>——它是你自己起的名字（比如 nas、zimeiti、photo），用来给「一类会话」打标签。
                </div>
                <div style={{ marginBottom: 6 }}>
                  2. 绑定生效的唯一条件：客户端发请求时带上 header <code>x-tdai-workspace-id: 你填的这个串</code>（<b>区分大小写、完全一致</b>）。目前各家客户端默认都不带，需要你在客户端配置自定义 header 或等后续版本支持。
                </div>
                <div style={{ marginBottom: 6 }}>
                  3. 配置示例（以 DSH 为例，若客户端支持）：请求头里加 <code>x-tdai-workspace-id: nas</code>，这里就填 <code>nas</code>。
                </div>
                <div>
                  4. ⚠️ 当前没有任何客户端默认发送该 header——填了也不会生效，建议先改用「会话级」绑定。
                </div>
              </div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={() => setStep(3)}>上一步</Button>
            <Button type="primary" disabled={!featureId.trim()} onClick={() => setStep(5)}>下一步</Button>
          </div>
        </div>
      );
    }
    if (step === 5) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>请核对绑定信息：</div>
          <div style={{ border: '1px solid var(--border, #ddd)', borderRadius: 4, padding: 12, background: 'var(--bg, #fafafa)' }}>
            <div>Agent：{selectedAgent ? `${selectedAgent.name} (${selectedAgent.agent_id})` : '-'}</div>
            <div>品牌：{brand}</div>
            <div>级别：{level === 'arm' ? '待命绑定（下一个新会话）' : level === 'session' ? '会话级' : 'workspace 级'}</div>
            <div>{level === 'arm' ? '有效期' : level === 'session' ? '会话 ID' : 'workspace'}：{level === 'arm' ? '24 小时内' : featureId}</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={() => setStep(4)}>上一步</Button>
            <Button type="primary" loading={busy} onClick={confirmCreate}>确认创建</Button>
          </div>
        </div>
      );
    }
    // step === 6：完成
    if (level === 'arm') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>✅ 待命绑定已创建！接下来只需要做一件事：</div>
          <div style={{ border: '1px solid #b8d4ff', borderRadius: 4, padding: 12, background: 'rgba(0,110,255,0.04)', lineHeight: 1.8 }}>
            回到 {brand}，<b>新开一个会话</b>并随便发一条消息（比如「hi」）。该会话将自动绑定到 {selectedAgent ? selectedAgent.name : '所选 Agent'}，绑定完成后此待命记录自动消失。
          </div>
          <div style={{ color: 'var(--muted-foreground, #888)', fontSize: 12 }}>
            ⏳ 待命有效期 24 小时；可随时在下方列表的「待命绑定」区查看或取消。
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              type="primary"
              onClick={() => resetWizardState(setStep, setAgentId, setBrand, setLevel, setFeatureId)}
            >
              再创建一个绑定
            </Button>
            <Button onClick={closeWizard}>关闭</Button>
          </div>
        </div>
      );
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>绑定已创建，请按实际情况选择收尾方式：</div>
        <div style={{ border: '1px solid var(--border, #ddd)', borderRadius: 4, padding: 12 }}>
          <div><b>这是新会话</b></div>
          <div style={{ marginTop: 4 }}>
            回到客户端<b>用同一会话发消息</b>即可，绑定将自动生效。
            若该会话已发过消息，请<b>新开会话</b>并重新绑定。
          </div>
        </div>
        <div style={{ border: '1px solid var(--border, #ddd)', borderRadius: 4, padding: 12 }}>
          <div><b>这是历史会话</b></div>
          <div style={{ margin: '8px 0', background: 'var(--bg, #f5f5f5)', padding: 8, fontFamily: 'monospace', wordBreak: 'break-all' }}>
            {importCommand}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button onClick={copyCommand}>复制命令</Button>
            <span style={{ color: 'var(--muted-foreground)', fontSize: 12 }}>
              在你本机（会话文件所在机器）的仓库根目录执行；导入完成后再新开会话。
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            type="primary"
            onClick={() => resetWizardState(setStep, setAgentId, setBrand, setLevel, setFeatureId)}
          >
            再创建一个绑定
          </Button>
          <Button onClick={closeWizard}>关闭</Button>
        </div>
      </div>
    );
  }

  // ---- 列表 ----
  function renderList() {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <Button onClick={() => refresh()}>刷新</Button>
        </div>
        {armRows.length > 0 && (
          <div>
            <h4 style={{ margin: '0 0 8px' }}>⏳ 待命绑定（等待下一个新会话）</h4>
            <Table
              records={armRows}
              recordKey="workspace_id"
              columns={[
                { key: 'brand', header: '品牌', render: (r: Binding) => r.workspace_id.split(':')[1] || '-' },
                { key: 'remain', header: '剩余待命时间', render: (r: Binding) => armRemain(r.workspace_id) },
                { key: 'agent', header: '目标 Agent', render: (r: Binding) => agentName(r.agent_id) },
                { key: 'updated_at', header: '创建时间', render: (r: Binding) => r.updated_at || '-' },
                {
                  key: 'ops', header: '操作', render: (r: Binding) => (
                    <Button type="link" onClick={() => remove(r.workspace_id)}>取消</Button>
                  ),
                },
              ]}
            />
          </div>
        )}
        <div>
          <h4 style={{ margin: '0 0 8px' }}>Workspace 级绑定</h4>
          <Table
            records={wsRows}
            recordKey="workspace_id"
            columns={[
              { key: 'ws', header: 'Workspace', render: (r: Binding) => r.workspace_id },
              { key: 'agent', header: '目标 Agent', render: (r: Binding) => agentName(r.agent_id) },
              { key: 'updated_at', header: '更新时间', render: (r: Binding) => r.updated_at || '-' },
              {
                key: 'ops', header: '操作', render: (r: Binding) => (
                  <Button type="link" onClick={() => remove(r.workspace_id)}>删除</Button>
                ),
              },
            ]}
          />
        </div>
        <div>
          <h4 style={{ margin: '0 0 8px' }}>会话级绑定</h4>
          <Table
            records={sessionRows}
            recordKey="workspace_id"
            columns={[
              { key: 'session', header: 'Session ID', render: (r: Binding) => r.workspace_id.slice('session:'.length) },
              { key: 'brand', header: '品牌', render: () => '-' },
              { key: 'agent', header: '目标 Agent', render: (r: Binding) => agentName(r.agent_id) },
              { key: 'updated_at', header: '更新时间', render: (r: Binding) => r.updated_at || '-' },
              {
                key: 'ops', header: '操作', render: (r: Binding) => (
                  <Button type="link" onClick={() => remove(r.workspace_id)}>删除</Button>
                ),
              },
            ]}
          />
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 18 }}>会话默认绑定</h3>
          <span style={{ color: 'var(--muted-foreground)', fontSize: 12 }}>
            为新会话指定默认 Agent：按会话或按 workspace 绑定
          </span>
        </div>
        <Button type="primary" onClick={() => setWizardOpen(true)}>＋ 新建绑定</Button>
      </div>
      <Alert type="info">
        生效优先级：<b>已初始化会话 &gt; 待命绑定（下一个新会话）&gt; 会话级绑定 &gt; workspace 级绑定 &gt; header 预设 &gt; 交互表单</b>。
        绑定只对<b>绑定之后新初始化的会话</b>生效，已聊过的会话不会自动重绑。
      </Alert>

      {msg && <Alert type={msgType}>{msg}</Alert>}

      {renderList()}

      <Modal
        visible={wizardOpen}
        caption="新建会话绑定"
        onClose={closeWizard}
        size="l"
        disableEscape={busy}
      >
        <Modal.Body>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <StepBar current={step - 1} />
            {renderStepBody()}
          </div>
        </Modal.Body>
      </Modal>
    </div>
  );
}

export default SessionDefaultPage;
