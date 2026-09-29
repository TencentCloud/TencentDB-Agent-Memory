import { describe, expect, it, vi } from 'vitest';
import { credentialMatchesRepo, isSshGitUrl, normalizeGitUrl } from '../../web/src/pages/CodePage/constants/code-constants';

vi.mock('@/lib/asset-common', () => ({ formatShortTime: vi.fn() }));

describe('Git registration URL validation', () => {
  it.each(['git@host:org/repo.git', 'ssh://git@host:2222/org/repo.git', 'ssh://git@[2001:db8::1]:2222/repo.git'])('accepts SSH identity reuse for %s', (url) => {
    expect(isSshGitUrl(url)).toBe(true);
    expect(credentialMatchesRepo({ kind: 'ssh', hostname: null }, url)).toBe(true);
    expect(credentialMatchesRepo({ kind: 'https', hostname: 'host' }, url)).toBe(false);
  });

  it('matches HTTPS hostnames across paths and ports without parsing path punctuation as SSH', () => {
    const credential = { kind: 'https' as const, hostname: 'cnb.cool' };
    for (const url of ['https://CNB.COOL:8443/org/repo', 'https://cnb.cool./other/repo', 'https://cnb.cool/org@name:repo']) {
      expect(credentialMatchesRepo(credential, url)).toBe(true);
      expect(isSshGitUrl(url)).toBe(false);
    }
    expect(credentialMatchesRepo(credential, 'https://other.cnb.cool/repo')).toBe(false);
  });

  it.each([String.raw`https://cnb.cool\@other.example/repo`, 'ssh://git@host:2222', 'ssh://git@host', 'https://u:p@cnb.cool/repo', 'http://cnb.cool/repo'])('rejects ambiguous or unsupported URL %s', (url) => {
    expect(normalizeGitUrl(url)).toBeNull();
    expect(credentialMatchesRepo({ kind: 'https', hostname: 'cnb.cool' }, url)).toBe(false);
  });
});
