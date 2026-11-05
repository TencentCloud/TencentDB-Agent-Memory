import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Copy } from 'tea-component';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { SkillReviewFile, SkillReviewSide } from '@/lib/api/skill-api';
import { buildSkillDiff, visibleDiffRows, type DiffLine } from '../utils/skill-diff';
import '../styles/skill-review.css';

export function reviewFileList(
  preview: {
    review_files?: SkillReviewFile[];
    previous_content: string;
    content: string;
    files: { added: string[]; changed: string[]; removed: string[] };
  },
  installing = false,
): SkillReviewFile[] {
  const side = (text: string): SkillReviewSide => ({
    size: new TextEncoder().encode(text).length,
    executable: false,
    hash: '',
    text,
  });
  return (
    preview.review_files ?? [
      {
        path: 'SKILL.md',
        status: installing
          ? 'added'
          : preview.content === preview.previous_content
            ? 'unchanged'
            : 'changed',
        before: installing ? null : side(preview.previous_content),
        after: side(preview.content),
      },
      ...(['added', 'changed', 'removed'] as const).flatMap((status) =>
        preview.files[status].map((path) => ({ path, status, before: null, after: null })),
      ),
    ]
  );
}
export function ReviewRevision({ value }: { value: string }) {
  return (
    <span className="skill-review-revision">
      <code title={value}>{/^[a-f0-9]{40}$/.test(value) ? value.slice(0, 8) : value}</code>
      <Copy text={value} />
    </span>
  );
}
export default function SkillReview(props: {
  name: string;
  beforeLabel: string;
  afterLabel: string;
  files: SkillReviewFile[];
  beforeContent: string;
  afterContent: string;
  details: ReactNode;
  loadFile: (path: string, signal?: AbortSignal) => Promise<SkillReviewFile>;
  notice?: ReactNode;
  actions: ReactNode;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState(
    () =>
      props.files.find((f) => f.status !== 'unchanged' && !f.before?.reason && !f.after?.reason)
        ?.path ??
      props.files.find((f) => f.status !== 'unchanged')?.path ??
      'SKILL.md',
  );
  const [query, setQuery] = useState('');
  const [all, setAll] = useState(false);
  const [file, setFile] = useState<SkillReviewFile | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [layout, setLayout] = useState<'split' | 'unified' | null>(null);
  const [compact, setCompact] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 850,
  );
  const effectiveLayout = layout ?? (compact ? 'unified' : 'split');
  const shell = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!shell.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) =>
      setCompact(entries[0].contentRect.width <= 800),
    );
    observer.observe(shell.current);
    return () => observer.disconnect();
  }, []);
  const [reading, setReading] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [currentChange, setCurrentChange] = useState(-1);
  const canvas = useRef<HTMLDivElement>(null);
  const load = useRef(props.loadFile);
  load.current = props.loadFile;
  const cache = useRef(new Map<string, SkillReviewFile>());
  const changed = props.files.filter((f) => f.status !== 'unchanged');
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setError('');
    setFile(null);
    setExpanded(new Set());
    setReading(false);
    setCurrentChange(-1);
    const descriptor = props.files.find((f) => f.path === selected);
    if (selected === 'SKILL.md' && descriptor) {
      const withText = (side: SkillReviewSide | null, text: string) =>
        side && { ...side, ...(side.reason ? {} : { text }) };
      setFile({
        ...descriptor,
        before: withText(descriptor.before, props.beforeContent),
        after: withText(descriptor.after, props.afterContent),
      });
      setLoading(false);
      return;
    }
    if (cache.current.has(selected)) {
      setFile(cache.current.get(selected)!);
      setLoading(false);
      return;
    }
    setLoading(true);
    load
      .current(selected, controller.signal)
      .then((value) => {
        if (active) {
          cache.current.set(selected, value);
          setFile(value);
        }
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [selected, retry]);
  const rows = useMemo(
    () =>
      file && !file.before?.reason && !file.after?.reason
        ? buildSkillDiff(file.before?.text ?? '', file.after?.text ?? '')
        : null,
    [file],
  );
  const displayRows = useMemo(
    () =>
      rows
        ? visibleDiffRows(rows, false).flatMap((row) =>
            'hidden' in row && expanded.has(row.key)
              ? rows.slice(row.key, row.key + row.hidden)
              : [row],
          )
        : [],
    [rows, expanded],
  );
  const changes = rows?.filter((row) => row.anchor !== undefined).length ?? 0;
  const totals = rows?.reduce(
    (a, row) => ({
      added: a.added + Number(row.changed && !!row.after),
      removed: a.removed + Number(row.changed && !!row.before),
    }),
    { added: 0, removed: 0 },
  );
  const noChanges = changed.length === 0;
  function jump(direction: number) {
    if (!changes || !canvas.current) return;
    const next =
      currentChange < 0
        ? direction < 0
          ? changes - 1
          : 0
        : (currentChange + direction + changes) % changes;
    const target = canvas.current.querySelector<HTMLElement>(`[data-change="${next}"]`);
    target?.scrollIntoView({ block: 'center', behavior: 'auto' });
    target?.focus({ preventScroll: true });
    setCurrentChange(next);
  }
  const cell = (line: DiffLine | undefined, kind: 'before' | 'after', isChanged: boolean) => (
    <div
      className={`skill-diff-cell ${kind} ${isChanged && line ? (kind === 'before' ? 'removed' : 'added') : ''}`}
    >
      <span className="skill-diff-number" aria-hidden="true">
        {line?.number}
      </span>
      <span className="skill-diff-mark" aria-hidden="true">
        {isChanged && line ? (kind === 'before' ? '−' : '+') : ' '}
      </span>
      <code>
        {line?.text || (line ? ' ' : '')}
        {line?.eof && <span className="skill-diff-eof"> ↵ {t('skills.review.noNewline')}</span>}
      </code>
    </div>
  );
  return (
    <div ref={shell} className="skill-review">
      <header className="skill-review-header">
        <div className="skill-review-title">
          <h2>{props.name}</h2>
          <span>{t('skills.review.changedCount', { count: changed.length })}</span>
        </div>
        <div className="skill-review-versions">
          <ReviewRevision value={props.beforeLabel} />
          <span aria-hidden="true">→</span>
          <ReviewRevision value={props.afterLabel} />
        </div>
        <details className="skill-review-source">
          <summary>{t('skills.review.source')}</summary>
          <div>{props.details}</div>
        </details>
      </header>
      {props.notice && <div className="skill-review-notice">{props.notice}</div>}
      {noChanges && !all ? (
        <div className="skill-review-empty">
          <span className="skill-review-check" aria-hidden="true">
            ✓
          </span>
          <h3>{t('skills.review.noChanges')}</h3>
          <p>{t('skills.review.noChangesHint')}</p>
          <Button onClick={() => setAll(true)}>{t('skills.review.browse')}</Button>
        </div>
      ) : (
        <div className="skill-review-workspace">
          <aside className="skill-review-files" aria-label={t('skills.review.files')}>
            <label className="skill-review-search">
              <span>{t('skills.review.files')}</span>
              <input
                aria-label={t('skills.review.search')}
                placeholder={t('skills.review.search')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <label className="skill-review-all">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
              {t('skills.review.unchangedFiles')}
            </label>
            <div className="skill-review-file-list">
              {props.files
                .filter(
                  (f) =>
                    (all || f.status !== 'unchanged') &&
                    f.path.toLowerCase().includes(query.toLowerCase()),
                )
                .map((f) => (
                  <button
                    key={f.path}
                    className={`skill-review-file ${selected === f.path ? 'selected' : ''}`}
                    aria-label={`${f.path} ${t(`skills.review.${f.status}`)}`}
                    aria-pressed={selected === f.path}
                    onClick={() => setSelected(f.path)}
                    title={f.path}
                  >
                    <span
                      className={`skill-review-status ${f.status}`}
                      title={t(`skills.review.${f.status}`)}
                    >
                      {{ added: 'A', removed: 'D', changed: 'M', unchanged: '·' }[f.status]}
                    </span>
                    <span className="skill-review-path">
                      <strong>{f.path.split('/').at(-1)}</strong>
                      {f.path.includes('/') && (
                        <small>{f.path.slice(0, f.path.lastIndexOf('/'))}/</small>
                      )}
                    </span>
                    <span className="skill-review-sr">{t(`skills.review.${f.status}`)}</span>
                  </button>
                ))}
              {!props.files.some(
                (f) =>
                  (all || f.status !== 'unchanged') &&
                  f.path.toLowerCase().includes(query.toLowerCase()),
              ) && <p>{t('skills.review.noFiles')}</p>}
            </div>
          </aside>
          <section className="skill-review-content" aria-label={selected}>
            <div className="skill-review-toolbar">
              <div className="skill-review-filename">
                <strong title={selected}>{selected}</strong>
                {totals && (
                  <span className="skill-review-counts">
                    <span>+{totals.added}</span>
                    <span>−{totals.removed}</span>
                  </span>
                )}
              </div>
              <div className="skill-review-controls">
                <button aria-pressed={!reading} onClick={() => setReading(false)}>
                  {t('skills.review.diff')}
                </button>
                {/\.md$/i.test(selected) && (
                  <button
                    disabled={!file || !!file.after?.reason || !file.after}
                    aria-pressed={reading}
                    onClick={() => setReading(true)}
                  >
                    {t('skills.review.read')}
                  </button>
                )}
                {!reading && (
                  <>
                    <button
                      className="skill-review-layout"
                      aria-pressed={effectiveLayout === 'split'}
                      onClick={() => setLayout(effectiveLayout === 'split' ? 'unified' : 'split')}
                    >
                      {t(`skills.review.${effectiveLayout}`)}
                    </button>
                    <button
                      disabled={!changes}
                      onClick={() => jump(-1)}
                      aria-label={t('skills.review.prev')}
                    >
                      ↑
                    </button>
                    <button
                      disabled={!changes}
                      onClick={() => jump(1)}
                      aria-label={t('skills.review.next')}
                    >
                      ↓
                    </button>
                  </>
                )}
              </div>
            </div>
            <div
              ref={canvas}
              className={`skill-review-canvas ${effectiveLayout}`}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                  e.preventDefault();
                  jump(e.key === 'ArrowDown' ? 1 : -1);
                }
              }}
              aria-busy={loading}
            >
              {loading && (
                <div className="skill-review-state" role="status">
                  {t('skills.review.loading')}
                </div>
              )}
              {error && (
                <div className="skill-review-state" role="alert">
                  <p>{error}</p>
                  <Button onClick={() => setRetry((n) => n + 1)}>{t('skills.review.retry')}</Button>
                </div>
              )}
              {file && (
                <>
                  <div className="skill-review-file-meta">
                    {t('skills.review.before')}:{' '}
                    {file.before
                      ? `${file.before.size.toLocaleString()} B · ${file.before.executable ? '100755' : '100644'}`
                      : '—'}
                    <span>→</span>
                    {t('skills.review.after')}:{' '}
                    {file.after
                      ? `${file.after.size.toLocaleString()} B · ${file.after.executable ? '100755' : '100644'}`
                      : '—'}
                  </div>
                  {file.before &&
                    file.after &&
                    file.before.executable !== file.after.executable && (
                      <p className="skill-review-summary">{t('skills.review.modeChanged')}</p>
                    )}
                  {reading ? (
                    <div className="skill-review-markdown">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          img: ({ alt }) => <span>[{alt ?? t('skills.review.image')}]</span>,
                        }}
                      >
                        {file.after?.text ?? ''}
                      </ReactMarkdown>
                    </div>
                  ) : file.before?.reason || file.after?.reason || !rows ? (
                    <div className="skill-review-state">
                      <h3>
                        {t(
                          `skills.review.${file.before?.reason ?? file.after?.reason ?? 'complex'}`,
                        )}
                      </h3>
                      <p>{t('skills.review.summaryOnly')}</p>
                      {[file.before, file.after].map(
                        (side, i) =>
                          side && (
                            <p className="skill-review-hash" key={i}>
                              {t(i ? 'skills.review.after' : 'skills.review.before')}: SHA-256{' '}
                              <code>{side.hash}</code>
                            </p>
                          ),
                      )}
                    </div>
                  ) : (
                    <>
                      <div className="skill-diff-labels">
                        <span>{t('skills.review.before')}</span>
                        <span>{t('skills.review.after')}</span>
                      </div>
                      {!changes && (
                        <p className="skill-review-summary">{t('skills.review.sameText')}</p>
                      )}
                      {displayRows.map((row, i) =>
                        'hidden' in row ? (
                          <button
                            className="skill-diff-fold"
                            key={`fold-${row.key}`}
                            onClick={() =>
                              setExpanded((previous) => new Set([...previous, row.key]))
                            }
                          >
                            {t('skills.review.expand', { count: row.hidden })}
                          </button>
                        ) : (
                          <div
                            className={`skill-diff-row ${row.changed ? 'changed' : 'same'}`}
                            key={i}
                            data-change={row.anchor}
                            tabIndex={row.anchor !== undefined ? -1 : undefined}
                          >
                            {cell(row.before, 'before', row.changed)}
                            {cell(row.after, 'after', row.changed)}
                          </div>
                        ),
                      )}
                      {expanded.size > 0 && (
                        <button className="skill-diff-fold" onClick={() => setExpanded(new Set())}>
                          {t('skills.review.collapse')}
                        </button>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          </section>
        </div>
      )}
      <footer className="skill-review-footer">{props.actions}</footer>
    </div>
  );
}
