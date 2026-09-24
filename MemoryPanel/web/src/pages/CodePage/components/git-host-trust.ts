import i18n from '@/i18n';
import { knowledgeApi, type GitCredentialInfo } from '@/lib/api/knowledge-api';
import { tea } from '@/lib/tea-bridge';

/** Discover public server keys before sending any authentication. Persist only after confirmation. */
export async function ensureGitHostTrusted(teamId: string, credential: GitCredentialInfo | undefined, repoUrl: string, refresh = false): Promise<boolean> {
  if (credential?.kind !== 'ssh') return true;
  const host = await knowledgeApi.gitCredentials.hostKey(teamId, credential.credential_id, repoUrl, refresh);
  if (host.trusted) return true;
  const confirmed = await tea.confirm({
    message: i18n.t(host.previous_known_hosts ? 'gitCredential.hostChanged' : 'gitCredential.hostConfirm', { server: host.server_url }),
    description: `${host.fingerprints.join('\n')}\n\n${i18n.t('gitCredential.verifyFingerprint')}`,
    okText: i18n.t('gitCredential.trustHost'),
    cancelText: i18n.t('common.cancel'),
  });
  if (!confirmed) return false;
  await knowledgeApi.gitCredentials.trustHost(teamId, credential.credential_id, repoUrl, host);
  return true;
}
