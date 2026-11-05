import SkillReview, { reviewFileList } from './SkillReview';
import '../styles/import-skill-dialog.css';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Checkbox, Form, Input } from 'tea-component';
import {
  applyGitHubSkill,
  detachGitHubSkill,
  previewGitHubSkill,
  previewGitHubFile,
  type GitHubSkillContext,
  type GitHubSkillPreview,
} from '@/lib/api/skill-api';

/** Preview and confirmation deliberately remain separate requests. */
export default function GitHubSkillForm(props: {
  context: GitHubSkillContext;
  onImported: () => void;
  onClose?: () => void;
  autoPreview?: boolean;
  onReviewChange?: (reviewing: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const [repository, setRepository] = useState('');
  const [ref, setRef] = useState('');
  const [path, setPath] = useState('');
  const [preview, setPreview] = useState<GitHubSkillPreview | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const context = {
    ...props.context,
    ...(props.context.skill_id ? {} : { repository, ref, path }),
  };
  const invalidate = () => {
    setPreview(null);
    setOverwrite(false);
    setError('');
    props.onReviewChange?.(false);
  };
  async function run(action: 'preview' | 'apply' | 'detach') {
    if (busy) return;
    setBusy(true);
    props.onBusyChange?.(true);
    setError('');
    try {
      if (action === 'preview') {
        setPreview(null);
        setOverwrite(false);
        setPreview(await previewGitHubSkill(context));
        props.onReviewChange?.(true);
      } else if (preview) {
        if (action === 'detach')
          await detachGitHubSkill({ ...context, expected_version: preview.expected_version });
        else
          await applyGitHubSkill({
            ...context,
            commit: preview.source.commit,
            digest: preview.source.digest,
            expected_version: preview.expected_version,
            overwrite_local: overwrite,
          });
        props.onImported();
      }
    } catch (err) {
      if (action === 'preview') props.onReviewChange?.(false);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      props.onBusyChange?.(false);
    }
  }
  useEffect(() => {
    if (props.autoPreview) void run('preview');
  }, []);
  if (preview)
    return (
      <SkillReview
        key={`${preview.expected_version}:${preview.source.digest}`}
        name={preview.name}
        beforeLabel={
          preview.previous_source?.commit ??
          (preview.expected_version ? `v${preview.expected_version}` : t('skills.review.initial'))
        }
        afterLabel={preview.source.commit}
        files={reviewFileList(preview, !context.skill_id)}
        beforeContent={preview.previous_content}
        afterContent={preview.content}
        loadFile={(file_path, signal) =>
          previewGitHubFile(
            {
              ...context,
              file_path,
              expected_version: preview.expected_version,
              commit: preview.source.commit,
              digest: preview.source.digest,
            },
            signal,
          )
        }
        details={
          <>
            <p>{preview.source.repository}</p>
            <p>
              {preview.source.path || '/'} · {preview.source.ref}
            </p>
            <p>{preview.source.checked_at}</p>
            {preview.source.declared_version && <p>{preview.source.declared_version}</p>}
          </>
        }
        notice={
          error ? (
            <span role="alert">{error}</span>
          ) : preview.local_modified ? (
            <span>{t('skills.github.conflict')}</span>
          ) : undefined
        }
        actions={
          <>
            {preview.local_modified ? (
              <span className="skill-review-consent">
                <Checkbox value={overwrite} disabled={busy} onChange={setOverwrite}>
                  {t('skills.github.overwrite')}
                </Checkbox>
              </span>
            ) : (
              <span className="skill-review-secondary">
                <Button disabled={busy} onClick={() => void run('preview')}>
                  {t('skills.review.refresh')}
                </Button>
              </span>
            )}
            {preview.local_modified && (
              <Button disabled={busy} onClick={() => void run('preview')}>
                {t('skills.review.refresh')}
              </Button>
            )}
            {context.skill_id && (
              <Button disabled={busy} onClick={() => void run('detach')}>
                {t('skills.github.detach')}
              </Button>
            )}
            <Button
              disabled={busy}
              onClick={() => (props.onClose ? props.onClose() : invalidate())}
            >
              {t('importSkill.cancel')}
            </Button>
            <Button
              type="primary"
              loading={busy}
              disabled={
                busy ||
                (preview.local_modified && !overwrite) ||
                (!preview.update_available && !preview.local_modified)
              }
              onClick={() => void run('apply')}
            >
              {t(context.skill_id ? 'skills.github.upgrade' : 'skills.github.install')}
            </Button>
          </>
        }
      />
    );
  return (
    <div className="_memory-github-skill">
      <Alert type="info">{t('skills.github.hint')}</Alert>
      {!props.context.skill_id && (
        <Form layout="vertical" style={{ width: '100%' }}>
          <Form.Item label={t('skills.github.repository')}>
            <Input
              size="full"
              value={repository}
              disabled={busy}
              placeholder="https://github.com/owner/repository"
              onChange={(v) => {
                setRepository(v);
                invalidate();
              }}
            />
          </Form.Item>
          <Form.Item label={t('skills.github.ref')}>
            <Input
              size="full"
              value={ref}
              disabled={busy}
              placeholder="HEAD"
              onChange={(v) => {
                setRef(v);
                invalidate();
              }}
            />
          </Form.Item>
          <Form.Item label={t('skills.github.path')}>
            <Input
              size="full"
              value={path}
              disabled={busy}
              placeholder="skills/my-skill"
              onChange={(v) => {
                setPath(v);
                invalidate();
              }}
            />
          </Form.Item>
        </Form>
      )}
      <Button
        disabled={busy || !context.agent_id || (!context.skill_id && !repository)}
        loading={busy}
        onClick={() => void run('preview')}
      >
        {t(context.skill_id ? 'skills.github.check' : 'skills.github.preview')}
      </Button>
      {!context.agent_id && <Alert type="warning">{t('importSkill.error.noAgent')}</Alert>}
      {error && <Alert type="error">{error}</Alert>}
    </div>
  );
}
