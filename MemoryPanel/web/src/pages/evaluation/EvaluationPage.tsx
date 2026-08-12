import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Select, Tag } from 'tea-component';
import { useTranslation } from 'react-i18next';
import { evaluationApi, EvaluationApiError, type EvaluationDetail, type EvaluationListItem, type EvaluationResultLabel } from '@/lib/evaluation-api';
import { useTeams } from '@/services';
import './evaluation-page.css';

const RESULT_OPTIONS: Array<{ value: EvaluationResultLabel | ''; text: string }> = [
  { value: '', text: '全部结果' }, { value: 'POSITIVE', text: 'Recorded Positive' },
  { value: 'INCONCLUSIVE', text: 'Inconclusive' }, { value: 'NEGATIVE', text: 'Recorded Negative' },
];

function displayError(error: unknown): string {
  if (error instanceof EvaluationApiError && error.code === 503) return '合成评测 Bundle 当前不可用；Memory Panel 其他功能不受影响。';
  if (error instanceof Error) return error.message;
  return '读取评测数据失败';
}

export function EvaluationPage() {
  const { t } = useTranslation();
  const { activeTeamId } = useTeams();
  const [keyword, setKeyword] = useState('');
  const [label, setLabel] = useState<EvaluationResultLabel | ''>('');
  const [items, setItems] = useState<EvaluationListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EvaluationDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!activeTeamId) { setItems([]); setDetail(null); return; }
    let cancelled = false; setLoading(true); setError('');
    evaluationApi.list(activeTeamId, { keyword: keyword.trim() || undefined, resultLabel: label || undefined })
      .then(({ items: next }) => { if (!cancelled) { setItems(next); setSelectedId((current) => next.some((item) => item.evaluationId === current) ? current : next[0]?.evaluationId ?? null); } })
      .catch((err) => { if (!cancelled) { setItems([]); setSelectedId(null); setError(displayError(err)); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activeTeamId, keyword, label]);

  useEffect(() => {
    setDetail(null);
    if (!activeTeamId || !selectedId) return;
    let cancelled = false;
    evaluationApi.get(activeTeamId, selectedId).then((next) => { if (!cancelled) setDetail(next); })
      .catch((err) => { if (!cancelled) { setDetail(null); setError(displayError(err)); } });
    return () => { cancelled = true; };
  }, [activeTeamId, selectedId]);

  const selected = useMemo(() => items.find((item) => item.evaluationId === selectedId), [items, selectedId]);

  return (
    <section className="evaluation-page">
      <header className="evaluation-hero">
        <div><p className="evaluation-kicker">GLOBAL_SYNTHETIC · READ ONLY</p><h1>{t('evaluation.title')}</h1><p>{t('evaluation.subtitle')}</p></div>
        <div className="evaluation-badges"><Tag theme="warning">Recorded E1</Tag><Tag theme="primary">合成 Fixture</Tag><Tag>非实时评测</Tag></div>
      </header>
      <div className="evaluation-disclaimer">合成控制器参考态，仅验证 Demo 契约与展示链路，不代表真实 Agent 收益、线上效果或平台能力。</div>
      <div className="evaluation-toolbar">
        <Input value={keyword} onChange={setKeyword} placeholder="筛选标题、ID、知识卡或标签" />
        <Select appearance="button" value={label} options={RESULT_OPTIONS} onChange={(value) => setLabel(value as EvaluationResultLabel | '')} />
        <Button type="link" onClick={() => { setKeyword(''); setLabel(''); }}>重置筛选</Button>
      </div>
      {!activeTeamId && <div className="evaluation-empty">请先选择团队。团队仅用于服务端真实成员权限校验，Bundle 不声明团队归属。</div>}
      {error && <div className="evaluation-error">{error}</div>}
      {activeTeamId && <div className="evaluation-grid">
        <aside className="evaluation-list">
          <div className="evaluation-list-title">Recorded 结果 <span>{items.length}</span></div>
          {loading && <div className="evaluation-empty">读取中…</div>}
          {!loading && items.length === 0 && !error && <div className="evaluation-empty">没有匹配的合成记录。</div>}
          {items.map((item) => <button type="button" key={item.evaluationId} className={item.evaluationId === selectedId ? 'evaluation-item active' : 'evaluation-item'} onClick={() => setSelectedId(item.evaluationId)}>
            <span className={`evaluation-result ${item.resultLabel.toLowerCase()}`}>{item.resultLabel}</span><strong>{item.title}</strong>
            <small>{new Date(item.generatedAt).toLocaleString()} · {item.sampleCount} Recorded samples</small>
            <span>{item.cardTitles.join(' · ')}</span>
          </button>)}
        </aside>
        <article className="evaluation-detail">
          {!selected && <div className="evaluation-empty">从左侧选择一条白名单详情。</div>}
          {detail && <>
            <div className="evaluation-detail-head"><div><span className={`evaluation-result ${detail.resultLabel.toLowerCase()}`}>{detail.resultLabel}</span><h2>{detail.title}</h2><code>{detail.evaluationId}</code></div><div className="evaluation-proof"><b>runExposure</b><span>NOT_PROVEN</span><b>E2</b><span>BLOCKED</span></div></div>
            <h3>知识卡展示投影</h3><p className="evaluation-note">以下卡片仅供展示（DISPLAY_ONLY），不表示已暴露给运行，也不构成效果归因。</p>
            <div className="evaluation-cards">{detail.knowledgeCards.map((card) => <div className="evaluation-card" key={card.cardId}><Tag>DISPLAY_ONLY</Tag><h4>{card.title}</h4><p>{card.summary}</p><div>{card.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div></div>)}</div>
            <h3>四格 Recorded Fixture 对照</h3><div className="evaluation-arms">{detail.comparison.map((arm) => <div key={arm.armId}><b>{arm.armId}</b><span>{arm.knowledgeVariant} · {arm.flowVariant}</span><strong>{arm.recordedAccepted ? 'Recorded accepted' : 'Recorded not accepted'}</strong><small>{arm.sampleCount} samples</small></div>)}</div>
            <div className="evaluation-columns"><section><h3>展示证据摘要</h3><ul>{detail.evidenceSummaries.map((item) => <li key={item}>{item}</li>)}</ul></section><section><h3>局限说明</h3><ul>{detail.limitations.map((item) => <li key={item}>{item}</li>)}</ul></section></div>
            <footer>Bundle {detail.bundleVersion} · {detail.bundleSha256.slice(0, 23)}… · liveAgentExecuted=false · catxCalled=false</footer>
          </>}
        </article>
      </div>}
    </section>
  );
}
