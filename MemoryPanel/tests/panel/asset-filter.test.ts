import { describe, expect, it } from 'vitest';
import {
  codeGraphSearchFields,
  filterByKeyword,
  isKeywordActive,
  matchesKeyword,
  normalizeKeyword,
  resolveFilterEmptyState,
  skillSearchFields,
  wikiSearchFields,
} from '../../web/src/lib/asset-filter';

const skills = [
  { skill_id: 'sk_001', name: 'Code-Review', description: 'Review pull requests' },
  { skill_id: 'sk_002', name: 'translator', description: '中英互译助手' },
  { skill_id: 'sk_ABC', name: 'planner', description: undefined },
];

const wikis = [
  {
    wiki_id: 'wk_alpha',
    name: 'Product Handbook',
    summary: 'Onboarding guide',
    source_url: 'https://iwiki.example.com/space/123',
    owner_user_id: 'u_alice',
  },
  { wiki_id: 'wk_beta', name: '运维手册', summary: null, source_url: null, owner_user_id: null },
];

const codes = [
  {
    code_graph_id: 'cg_1',
    repo_name: 'memory-server',
    repo_url: 'https://git.example.com/team/memory-server.git',
    branch: 'main',
    commit_hash: 'abc1234',
    owner_user_id: 'u_bob',
  },
  {
    code_graph_id: 'cg_2',
    repo_name: '',
    repo_url: 'git@github.com:org/panel-web.git',
    branch: 'release/v2',
    commit_hash: null,
    owner_user_id: null,
  },
];

describe('normalizeKeyword / isKeywordActive', () => {
  it('trims and lowercases', () => {
    expect(normalizeKeyword('  HeLLo ')).toBe('hello');
    expect(normalizeKeyword(undefined)).toBe('');
    expect(normalizeKeyword(null)).toBe('');
  });
  it('treats whitespace-only as inactive', () => {
    expect(isKeywordActive('   ')).toBe(false);
    expect(isKeywordActive('')).toBe(false);
    expect(isKeywordActive(' a ')).toBe(true);
  });
});

describe('matchesKeyword', () => {
  it('empty keyword always matches', () => {
    expect(matchesKeyword([], '')).toBe(true);
    expect(matchesKeyword(['x'], '  ')).toBe(true);
  });
  it('is case-insensitive substring match and skips null fields', () => {
    expect(matchesKeyword([null, undefined, 'FooBar'], 'oba')).toBe(true);
    expect(matchesKeyword([null, undefined, ''], 'x')).toBe(false);
  });
});

describe('filterByKeyword - skill', () => {
  const run = (kw: string) => filterByKeyword(skills, kw, skillSearchFields).map((s) => s.skill_id);
  it('returns all items (same reference) for empty keyword', () => {
    expect(filterByKeyword(skills, '', skillSearchFields)).toBe(skills);
    expect(run('   ')).toEqual(['sk_001', 'sk_002', 'sk_ABC']);
  });
  it('matches name, description and id', () => {
    expect(run('code-review')).toEqual(['sk_001']);
    expect(run('互译')).toEqual(['sk_002']);
    expect(run('pull REQUESTS')).toEqual(['sk_001']);
    expect(run('sk_abc')).toEqual(['sk_ABC']);
  });
  it('trims and ignores case', () => {
    expect(run('  PLANNER  ')).toEqual(['sk_ABC']);
  });
  it('returns empty when nothing matches', () => {
    expect(run('does-not-exist')).toEqual([]);
  });
});

describe('filterByKeyword - wiki', () => {
  const run = (kw: string) => filterByKeyword(wikis, kw, wikiSearchFields).map((w) => w.wiki_id);
  it('matches name, summary, id, source url and owner', () => {
    expect(run('handbook')).toEqual(['wk_alpha']);
    expect(run('onboarding')).toEqual(['wk_alpha']);
    expect(run('WK_BETA')).toEqual(['wk_beta']);
    expect(run('iwiki.example.com')).toEqual(['wk_alpha']);
    expect(run('u_alice')).toEqual(['wk_alpha']);
    expect(run('运维')).toEqual(['wk_beta']);
  });
  it('shared prefix matches multiple, no match returns empty', () => {
    expect(run('wk_')).toEqual(['wk_alpha', 'wk_beta']);
    expect(run('nothing-here')).toEqual([]);
  });
});

describe('filterByKeyword - codegraph', () => {
  const run = (kw: string, display?: (c: (typeof codes)[number]) => string) =>
    filterByKeyword(codes, kw, (c) => codeGraphSearchFields(c, display?.(c))).map(
      (c) => c.code_graph_id,
    );
  it('matches repo_name, repo_url, id, branch and commit', () => {
    expect(run('MEMORY-SERVER')).toEqual(['cg_1']);
    expect(run('github.com:org')).toEqual(['cg_2']);
    expect(run('cg_2')).toEqual(['cg_2']);
    expect(run('release/')).toEqual(['cg_2']);
    expect(run('abc12')).toEqual(['cg_1']);
  });
  it('matches the displayed name when repo_name is empty', () => {
    expect(run('panel-web', (c) => c.repo_name || 'org/panel-web')).toEqual(['cg_2']);
    expect(run(' ORG/PANEL ', (c) => c.repo_name || 'org/panel-web')).toEqual(['cg_2']);
  });
  it('returns all for empty and none for unknown keyword', () => {
    expect(run('')).toEqual(['cg_1', 'cg_2']);
    expect(run('zzz')).toEqual([]);
  });
});

describe('resolveFilterEmptyState', () => {
  it('distinguishes empty scope from no match', () => {
    expect(resolveFilterEmptyState(0, 0)).toBe('empty');
    expect(resolveFilterEmptyState(5, 0)).toBe('noMatch');
    expect(resolveFilterEmptyState(5, 2)).toBeNull();
  });
});
