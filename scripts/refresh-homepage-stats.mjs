#!/usr/bin/env node
/**
 * 定时刷新官网线上数据（gh-pages 分支根目录的 stats.json）。
 *
 * 由 .github/workflows/refresh-homepage-stats.yml 触发（schedule / 手动），
 * 运行在 GitHub Actions 环境，用内置 GITHUB_TOKEN 认证：
 *   1. 调 GitHub REST API 拉取 star / fork / 最新 release / tag；
 *   2. 生成与官网构建快照同构的 stats.json；
 *   3. 通过 Contents API 更新 gh-pages 分支上的 stats.json。
 *
 * 前端 useLiveStats 在页面加载后请求同域 /stats.json，实现两次部署之间
 * 版本号与仓库数据的自动刷新；本脚本失败不影响线上站点（前端回退构建快照）。
 *
 * 本地调试：GITHUB_TOKEN=xxx node scripts/refresh-homepage-stats.mjs --dry-run
 */
import { argv, env, exit } from 'node:process';

const DRY_RUN = argv.includes('--dry-run');
const REPO = env.STATS_REPO || 'TencentCloud/TencentDB-Agent-Memory';
const BRANCH = env.STATS_BRANCH || 'gh-pages';
const TOKEN = env.GITHUB_TOKEN;
const API = 'https://api.github.com';

if (!TOKEN) {
  console.error('缺少 GITHUB_TOKEN 环境变量');
  exit(1);
}

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'homepage-stats-refresher',
};

async function api(path) {
  const res = await fetch(`${API}${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return res.json();
}

/** 26700 -> "26.7k"，与官网 sync-site-data.mjs 保持一致。 */
function formatCount(value) {
  const n = Number(value) || 0;
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

async function buildStats() {
  const [meta, releases, tags, latest] = await Promise.all([
    api(`/repos/${REPO}`),
    api(`/repos/${REPO}/releases?per_page=100`),
    api(`/repos/${REPO}/tags?per_page=100`),
    api(`/repos/${REPO}/releases/latest`).catch(() => null),
  ]);

  const stableReleases = releases.filter((item) => !item.prerelease && !item.draft);
  const version = latest?.tag_name || releases[0]?.tag_name || tags[0]?.name || '';
  if (!version) throw new Error('没有取到任何 release/tag，跳过更新');

  return {
    generatedAt: new Date().toISOString(),
    repository: REPO,
    latestRelease: version,
    latestReleasePublishedAt: latest?.published_at || releases[0]?.published_at || '',
    latestTag: tags[0]?.name || version,
    releasesCount: stableReleases.length,
    releasesTotal: releases.length,
    stars: meta.stargazers_count ?? 0,
    starsLabel: formatCount(meta.stargazers_count),
    forks: meta.forks_count ?? 0,
    forksLabel: formatCount(meta.forks_count),
  };
}

async function currentFileSha() {
  try {
    const res = await fetch(`${API}/repos/${REPO}/contents/stats.json?ref=${BRANCH}`, {
      headers,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.sha || null;
  } catch {
    return null;
  }
}

async function updateStats(stats, sha) {
  const res = await fetch(`${API}/repos/${REPO}/contents/stats.json`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `chore: refresh stats.json (${stats.latestRelease}, ${stats.starsLabel} stars)`,
      content: Buffer.from(`${JSON.stringify(stats, null, 2)}\n`).toString('base64'),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`PUT contents -> HTTP ${res.status}: ${await res.text()}`);
  }
}

const stats = await buildStats();
console.log(`生成 stats.json：${stats.latestRelease} · ${stats.starsLabel} stars · ${stats.forksLabel} forks`);

if (DRY_RUN) {
  console.log('dry-run：未更新远端文件');
} else {
  const sha = await currentFileSha();
  await updateStats(stats, sha);
  console.log(`已更新 ${REPO}#${BRANCH} 上的 stats.json${sha ? `（覆盖 ${sha.slice(0, 8)}）` : '（新建）'}`);
}
