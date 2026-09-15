/**
 * SessionInitPage — 免登录的会话初始化落地页（路由 /session-init）。
 *
 * headless 客户端（dsh headless 等）无法弹交互表单时，proxy 会在响应里附一
 * 条短时效链接指向本页：`{hub}/#/session-init?proxy=<proxyOrigin>&token=<t>`。
 * 页面凭 token 向 proxy 拉取候选资产（team/agent/task），单页一次填完提交，
 * 绑定落 proxy SessionStore 后，原 headless 会话的后续请求即注入身份上下文。
 *
 * 本页不依赖 Panel 登录态——token 即唯一凭证（一次性、短时 TTL、由 proxy
 * 签发并绑定 sessionKey+userKey），因此挂在 ConsoleLayout 路由树之外。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import './style.css';

interface AgentInTeam {
  agent_id: string;
  agent_name: string;
  description?: string;
}

interface TaskInTeam {
  task_id: string;
  task_name: string;
  /** fetchTeamsAndAgents 注入的 defaultTaskId 虚拟条目；本页有自己的跳过项，需过滤防重复渲染 */
  isDefault?: boolean;
}

interface TeamOption {
  team_id: string;
  team_name: string;
  agents: AgentInTeam[];
  tasks: TaskInTeam[];
}

interface CandidatesResponse {
  purpose: 'init' | 'rebind';
  agent_source: string;
  session_id: string;
  expires_at: string;
  teams: TeamOption[];
}

interface SubmitResponse {
  ok: boolean;
  team_id: string;
  team_name: string;
  agent_id: string;
  task_id: string | null;
}

type Phase = 'loading' | 'ready' | 'submitting' | 'done' | 'error';

export default function SessionInitPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const proxyBase = (searchParams.get('proxy') ?? '').replace(/\/$/, '');
  const token = searchParams.get('token') ?? '';

  const [phase, setPhase] = useState<Phase>('loading');
  const [errorCode, setErrorCode] = useState<string>('');
  const [reason, setReason] = useState<string>('');
  const [candidates, setCandidates] = useState<CandidatesResponse | null>(null);
  const [teamId, setTeamId] = useState<string>('');
  const [agentId, setAgentId] = useState<string>('');
  const [taskId, setTaskId] = useState<string>('');
  const [result, setResult] = useState<SubmitResponse | null>(null);

  const failWith = useCallback((code: string, detail?: string) => {
    setErrorCode(code);
    setReason(detail ?? '');
    setPhase('error');
  }, []);

  useEffect(() => {
    if (!proxyBase || !token) {
      failWith('missing_params');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${proxyBase}/v3/session/init-link/${encodeURIComponent(token)}`);
        const data = (await res.json().catch(() => null)) as
          | (CandidatesResponse & { error?: string; reason?: string })
          | null;
        if (cancelled) return;
        if (!res.ok || !data || data.error) {
          failWith(data?.reason ?? data?.error ?? `http_${res.status}`);
          return;
        }
        setCandidates(data);
        if (data.teams.length === 1) setTeamId(data.teams[0].team_id);
        setPhase('ready');
      } catch (err) {
        if (!cancelled) failWith('network_error', err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [proxyBase, token, failWith]);

  const selectedTeam = useMemo(
    () => candidates?.teams.find((tm) => tm.team_id === teamId) ?? null,
    [candidates, teamId],
  );

  const submit = async () => {
    if (!agentId) return;
    setPhase('submitting');
    try {
      const res = await fetch(`${proxyBase}/v3/session/init-link/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId, task_id: taskId || undefined }),
      });
      const data = (await res.json().catch(() => null)) as
        | (SubmitResponse & { error?: string; reason?: string })
        | null;
      if (!res.ok || !data || data.error) {
        failWith(data?.reason ?? data?.error ?? `http_${res.status}`);
        return;
      }
      setResult(data);
      setPhase('done');
    } catch (err) {
      failWith('network_error', err instanceof Error ? err.message : String(err));
    }
  };

  if (phase === 'loading') {
    return (
      <div className="sip-page">
        <div className="sip-card sip-center">{t('sessionInit.loading')}</div>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="sip-page">
        <div className="sip-card sip-center">
          <div className="sip-title sip-error">{t('sessionInit.error.title')}</div>
          <p className="sip-dim">{t(`sessionInit.error.${errorCode}`, { defaultValue: t('sessionInit.error.generic') })}</p>
          {reason && <p className="sip-mono sip-dim">{reason}</p>}
        </div>
      </div>
    );
  }

  if (phase === 'done' && result) {
    return (
      <div className="sip-page">
        <div className="sip-card sip-center">
          <div className="sip-title sip-ok">✓ {t('sessionInit.done.title')}</div>
          <p>{t('sessionInit.done.subtitle')}</p>
          <div className="sip-result">
            <div><span className="sip-dim">{t('sessionInit.field.team')}</span> {result.team_name} <code>{result.team_id}</code></div>
            <div><span className="sip-dim">{t('sessionInit.field.agent')}</span> <code>{result.agent_id}</code></div>
            <div><span className="sip-dim">{t('sessionInit.field.task')}</span> {result.task_id ? <code>{result.task_id}</code> : t('sessionInit.noTask')}</div>
          </div>
          <p className="sip-dim">{t('sessionInit.done.hint')}</p>
          <a className="sip-home-btn" href={`${window.location.origin}/#/`}>{t('sessionInit.done.openHub')}</a>
        </div>
      </div>
    );
  }

  const meta = candidates ? (
    <p className="sip-dim sip-meta">
      {t('sessionInit.meta', {
        source: candidates.agent_source,
        session: candidates.session_id,
        purpose: candidates.purpose === 'rebind' ? t('sessionInit.purpose.rebind') : t('sessionInit.purpose.init'),
      })}
    </p>
  ) : null;

  return (
    <div className="sip-page">
      <div className="sip-card">
        <div className="sip-title">{t('sessionInit.title')}</div>
        <p className="sip-dim">{t('sessionInit.subtitle')}</p>
        {meta}

        {candidates && candidates.teams.length === 0 && (
          <p className="sip-error">{t('sessionInit.noTeams')}</p>
        )}

        {candidates && candidates.teams.length > 0 && (
          <>
            {candidates.teams.length > 1 && (
              <section className="sip-group">
                <h3>{t('sessionInit.field.team')}</h3>
                {candidates.teams.map((tm) => (
                  <label key={tm.team_id} className={`sip-option ${teamId === tm.team_id ? 'sip-active' : ''}`}>
                    <input
                      type="radio"
                      name="team"
                      checked={teamId === tm.team_id}
                      onChange={() => {
                        setTeamId(tm.team_id);
                        setAgentId('');
                        setTaskId('');
                      }}
                    />
                    <div>
                      <div className="sip-name">{tm.team_name}</div>
                      <code>{tm.team_id}</code>
                    </div>
                  </label>
                ))}
              </section>
            )}

            {selectedTeam && (
              <>
                <section className="sip-group">
                  <h3>{t('sessionInit.field.agent')}</h3>
                  {selectedTeam.agents.map((ag) => (
                    <label key={ag.agent_id} className={`sip-option ${agentId === ag.agent_id ? 'sip-active' : ''}`}>
                      <input
                        type="radio"
                        name="agent"
                        checked={agentId === ag.agent_id}
                        onChange={() => setAgentId(ag.agent_id)}
                      />
                      <div>
                        <div className="sip-name">{ag.agent_name}</div>
                        {ag.description && <div className="sip-dim sip-desc">{ag.description}</div>}
                        <code>{ag.agent_id}</code>
                      </div>
                    </label>
                  ))}
                </section>

                <section className="sip-group">
                  <h3>{t('sessionInit.field.task')}</h3>
                  <label className={`sip-option ${taskId === '' ? 'sip-active' : ''}`}>
                    <input type="radio" name="task" checked={taskId === ''} onChange={() => setTaskId('')} />
                    <div>
                      <div className="sip-name">{t('sessionInit.noTask')}</div>
                      <div className="sip-dim sip-desc">{t('sessionInit.noTaskHint')}</div>
                    </div>
                  </label>
                  {selectedTeam.tasks
                    .filter((tk) => !tk.isDefault)
                    .map((tk) => (
                    <label key={tk.task_id} className={`sip-option ${taskId === tk.task_id ? 'sip-active' : ''}`}>
                      <input type="radio" name="task" checked={taskId === tk.task_id} onChange={() => setTaskId(tk.task_id)} />
                      <div>
                        <div className="sip-name">{tk.task_name}</div>
                        <code>{tk.task_id}</code>
                      </div>
                    </label>
                  ))}
                </section>

                <button className="sip-submit" disabled={!agentId || phase === 'submitting'} onClick={submit}>
                  {phase === 'submitting' ? t('sessionInit.submitting') : t('sessionInit.submit')}
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
