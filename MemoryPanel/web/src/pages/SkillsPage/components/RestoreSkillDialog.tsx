import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Checkbox, Modal } from 'tea-component';
import {
  previewSkillRestore,
  restoreSkillVersion,
  type GitHubSkillContext,
  type SkillRestorePreview,
} from '@/lib/api/skill-api';
import '../styles/import-skill-dialog.css';

export default function RestoreSkillDialog(props: {
  context: GitHubSkillContext & { skill_id: string };
  sourceVersion: number;
  onClose: () => void;
  onRestored: () => void;
}) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<SkillRestorePreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(apply: boolean) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const input = { ...props.context, source_version: props.sourceVersion };
      if (apply && preview && confirmed) {
        await restoreSkillVersion({
          ...input,
          expected_version: preview.expected_version,
          digest: preview.digest,
        });
        props.onRestored();
      } else if (!apply) {
        setPreview(null);
        setConfirmed(false);
        setPreview(await previewSkillRestore(input));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      visible
      size="xl"
      caption={t('skills.restore.caption', { version: props.sourceVersion })}
      disableEscape={busy}
      onClose={() => {
        if (!busy) props.onClose();
      }}
    >
      <Modal.Body>
        <div className="_memory-github-skill">
          <Alert type="warning">{t('skills.restore.hint')}</Alert>
          <Button disabled={busy} loading={busy} onClick={() => void run(false)}>
            {t('skills.restore.preview')}
          </Button>
          {error && <Alert type="error">{error}</Alert>}
          {preview && (
            <>
              <p>
                {t('skills.restore.versions', {
                  current: preview.expected_version,
                  source: preview.source_version,
                  next: preview.expected_version + 1,
                })}
              </p>
              {preview.source && (
                <p>
                  GitHub: {preview.source.repository} · <code>{preview.source.commit}</code>
                </p>
              )}
              <div className="_memory-github-diff">
                <section>
                  <h4>{t('skills.github.before')}</h4>
                  <pre>{preview.previous_content}</pre>
                </section>
                <section>
                  <h4>{t('skills.restore.after')}</h4>
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
              <Checkbox value={confirmed} disabled={busy} onChange={setConfirmed}>
                {t('skills.restore.consent')}
              </Checkbox>
            </>
          )}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button
          type="primary"
          disabled={busy || !preview || !confirmed}
          loading={busy}
          onClick={() => void run(true)}
        >
          {t('skills.restore.confirm')}
        </Button>
        <Button disabled={busy} onClick={props.onClose}>
          {t('importSkill.cancel')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
