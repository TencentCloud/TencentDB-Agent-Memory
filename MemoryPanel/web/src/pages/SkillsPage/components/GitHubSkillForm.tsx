import '../styles/import-skill-dialog.css';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Checkbox, Form, Input } from 'tea-component';
import {
  applyGitHubSkill,
  detachGitHubSkill,
  previewGitHubSkill,
  type GitHubSkillContext,
  type GitHubSkillPreview,
} from '@/lib/api/skill-api';

/** Preview and confirmation deliberately remain separate requests. */
export default function GitHubSkillForm(props: {
  context: GitHubSkillContext;
  onImported: () => void;
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
  };
  async function run(action: 'preview' | 'apply' | 'detach') {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (action === 'preview') {
        setPreview(null);
        setOverwrite(false);
        setPreview(await previewGitHubSkill(context));
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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
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
      {preview && (
        <>
          <h3>{preview.name}</h3>
          <p>{preview.description}</p>
          <dl>
            <dt>{t('skills.github.repository')}</dt>
            <dd>{preview.source.repository}</dd>
            <dt>{t('skills.github.ref')}</dt>
            <dd>{preview.source.ref}</dd>
            <dt>{t('skills.github.path')}</dt>
            <dd>{preview.source.path || '/'}</dd>
            {preview.previous_source && (
              <>
                <dt>{t('skills.github.installedCommit')}</dt>
                <dd>
                  <code>{preview.previous_source.commit}</code>
                </dd>
              </>
            )}
            <dt>{t('skills.github.commit')}</dt>
            <dd>
              <code>{preview.source.commit}</code>
            </dd>
            {preview.source.declared_version && (
              <>
                <dt>{t('skills.github.declaredVersion')}</dt>
                <dd>{preview.source.declared_version}</dd>
              </>
            )}
            <dt>{t('skills.github.checked')}</dt>
            <dd>{preview.source.checked_at}</dd>
          </dl>
          {context.skill_id && !preview.update_available && (
            <Alert type="success">{t('skills.github.current')}</Alert>
          )}
          {preview.local_modified && (
            <Alert type="warning">
              <p>{t('skills.github.conflict')}</p>
              <Checkbox value={overwrite} disabled={busy} onChange={setOverwrite}>
                {t('skills.github.overwrite')}
              </Checkbox>
            </Alert>
          )}
          <div className="_memory-github-diff">
            {context.skill_id && (
              <section>
                <h4>{t('skills.github.before')}</h4>
                <pre>{preview.previous_content}</pre>
              </section>
            )}
            <section>
              <h4>{t('skills.github.after')}</h4>
              <pre>{preview.content}</pre>
            </section>
          </div>
          {(['added', 'changed', 'removed'] as const).map((kind) => (
            <div key={kind}>
              <strong>{t(`skills.github.${kind}`)}</strong>
              <ul>
                {preview.files[kind].map((file) => (
                  <li key={file}>
                    <code>{file}</code>
                  </li>
                ))}
              </ul>
            </div>
          ))}
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
          {context.skill_id && (
            <Button disabled={busy} onClick={() => void run('detach')}>
              {t('skills.github.detach')}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
