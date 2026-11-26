import SkillReview, { reviewFileList } from './SkillReview';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Checkbox, Modal } from 'tea-component';
import {
  previewSkillRestore,
  previewRestoreFile,
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
  autoPreview?: boolean;
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
  useEffect(() => {
    if (props.autoPreview) void run(false);
  }, []);
  return (
    <Modal
      visible
      size="calc(100vw - 48px)"
      className="skill-review-modal"
      caption={t('skills.restore.caption', { version: props.sourceVersion })}
      disableEscape={busy}
      onClose={() => {
        if (!busy) props.onClose();
      }}
    >
      <Modal.Body>
        {preview ? (
          <SkillReview
            key={`${preview.expected_version}:${preview.digest}`}
            name={preview.name}
            beforeLabel={`v${preview.expected_version}`}
            afterLabel={t('skills.review.restoreTarget', { version: preview.source_version })}
            files={reviewFileList(preview)}
            beforeContent={preview.previous_content}
            afterContent={preview.content}
            loadFile={(file_path, signal) =>
              previewRestoreFile(
                {
                  ...props.context,
                  source_version: props.sourceVersion,
                  expected_version: preview.expected_version,
                  digest: preview.digest,
                  file_path,
                },
                signal,
              )
            }
            details={
              <>
                <p>
                  {t('skills.restore.versions', {
                    current: preview.expected_version,
                    source: preview.source_version,
                    next: preview.expected_version + 1,
                  })}
                </p>
                {preview.source && (
                  <>
                    <p>{preview.source.repository}</p>
                    <p>
                      {preview.source.path} · {preview.source.ref}
                    </p>
                    <code>{preview.source.commit}</code>
                  </>
                )}
              </>
            }
            notice={
              error ? <span role="alert">{error}</span> : <span>{t('skills.restore.hint')}</span>
            }
            actions={
              <>
                <span className="skill-review-consent">
                  <Checkbox value={confirmed} disabled={busy} onChange={setConfirmed}>
                    {t('skills.restore.consent')}
                  </Checkbox>
                </span>
                <Button disabled={busy} onClick={() => void run(false)}>
                  {t('skills.restore.preview')}
                </Button>
                <Button disabled={busy} onClick={props.onClose}>
                  {t('importSkill.cancel')}
                </Button>
                <Button
                  type="primary"
                  disabled={busy || !confirmed}
                  loading={busy}
                  onClick={() => void run(true)}
                >
                  {t('skills.restore.confirm')}
                </Button>
              </>
            }
          />
        ) : (
          <div className="skill-review-state">
            <p>{t('skills.restore.hint')}</p>
            {error && <Alert type="error">{error}</Alert>}
            <Button loading={busy} disabled={busy} onClick={() => void run(false)}>
              {t('skills.restore.preview')}
            </Button>
            <Button disabled>{t('skills.restore.confirm')}</Button>
          </div>
        )}
      </Modal.Body>
    </Modal>
  );
}
