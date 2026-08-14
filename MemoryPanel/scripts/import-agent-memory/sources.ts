import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { MemoryDocument, MemorySource } from './plan.js';

export interface SourceReport {
  source: MemorySource;
  files: number;
  locations: number;
  notes: string[];
}

export interface ScanResult {
  documents: MemoryDocument[];
  reports: SourceReport[];
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function markdownFiles(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => entry.name)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function documentsFromDirectory(
  path: string,
  source: MemorySource,
  labelPrefix: string,
): Promise<MemoryDocument[]> {
  const names = await markdownFiles(path);
  const documents = await Promise.all(names.map(async (name) => ({
    source,
    sourceLabel: `${labelPrefix}/${name}`,
    content: await readFile(join(path, name), 'utf8'),
    split: 'h2' as const,
  })));
  return documents.filter((document) => document.content.trim());
}

export async function scanCodex(codexHome: string): Promise<ScanResult> {
  const root = join(resolve(codexHome), 'memories');
  const [summary, memory] = await Promise.all([
    readOptional(join(root, 'memory_summary.md')),
    readOptional(join(root, 'MEMORY.md')),
  ]);
  const documents: MemoryDocument[] = [];
  if (summary) {
    documents.push({ source: 'codex', sourceLabel: 'memory_summary.md', content: summary, split: 'h2' });
  }
  if (memory) {
    documents.push({ source: 'codex', sourceLabel: 'MEMORY.md', content: memory, split: 'codex-task-group' });
  }
  return {
    documents,
    reports: [{
      source: 'codex',
      files: documents.length,
      locations: documents.length ? 1 : 0,
      notes: [
        summary ? 'memory_summary.md found' : 'memory_summary.md missing',
        memory ? 'MEMORY.md found' : 'MEMORY.md missing',
      ],
    }],
  };
}

export async function scanWorkBuddy(
  workbuddyHome: string,
  workspaces: string[],
): Promise<ScanResult> {
  const documents: MemoryDocument[] = [];
  const notes: string[] = [];
  const userMemory = await readOptional(join(resolve(workbuddyHome), 'MEMORY.md'));
  if (userMemory) {
    documents.push({
      source: 'workbuddy',
      sourceLabel: 'user/MEMORY.md',
      content: userMemory,
      split: 'h2',
    });
    notes.push('user MEMORY.md found');
  } else {
    notes.push('user MEMORY.md missing');
  }

  let locations = userMemory ? 1 : 0;
  const resolvedWorkspaces = [...new Set(workspaces.map((path) => resolve(path)))];
  const nameCounts = new Map<string, number>();
  for (const workspace of resolvedWorkspaces) {
    const shortName = basename(workspace).replace(/[^a-zA-Z0-9._-]+/g, '-') || 'workspace';
    const occurrence = (nameCounts.get(shortName) ?? 0) + 1;
    nameCounts.set(shortName, occurrence);
    const label = `workspace/${shortName}${occurrence > 1 ? `-${occurrence}` : ''}`;
    const found = await documentsFromDirectory(
      join(workspace, '.workbuddy', 'memory'),
      'workbuddy',
      label,
    );
    if (found.length) locations += 1;
    documents.push(...found);
  }
  notes.push(`${workspaces.length} workspace path(s) checked`);
  return {
    documents,
    reports: [{ source: 'workbuddy', files: documents.length, locations, notes }],
  };
}

function configuredMemoryPath(value: string): string | undefined {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return resolve(homedir(), value.slice(2));
  }
  return isAbsolute(value) ? resolve(value) : undefined;
}

export async function scanClaude(claudeHome: string): Promise<ScanResult> {
  const root = resolve(claudeHome);
  const notes: string[] = [];
  const settings = await readOptional(join(root, 'settings.json'));
  let customDirectory: string | undefined;
  if (settings) {
    try {
      const value = (JSON.parse(settings.replace(/^\uFEFF/, '')) as {
        autoMemoryDirectory?: unknown;
      }).autoMemoryDirectory;
      if (typeof value === 'string') {
        customDirectory = configuredMemoryPath(value);
        if (!customDirectory) notes.push('autoMemoryDirectory ignored: expected an absolute or ~/ path');
      }
    } catch {
      notes.push('settings.json is invalid JSON; scanning default project memories instead');
    }
  }

  if (customDirectory) {
    const documents = await documentsFromDirectory(customDirectory, 'claude', 'custom');
    notes.push('user autoMemoryDirectory checked');
    return {
      documents,
      reports: [{ source: 'claude', files: documents.length, locations: documents.length ? 1 : 0, notes }],
    };
  }

  let projectDirectories: string[] = [];
  try {
    const entries = await readdir(join(root, 'projects'), { withFileTypes: true });
    projectDirectories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const documents: MemoryDocument[] = [];
  let locations = 0;
  for (const [index, projectDirectory] of projectDirectories.entries()) {
    const found = await documentsFromDirectory(
      join(root, 'projects', projectDirectory, 'memory'),
      'claude',
      `project-${index + 1}`,
    );
    if (found.length) locations += 1;
    documents.push(...found);
  }
  notes.push(`${projectDirectories.length} Claude project directories checked`);
  return {
    documents,
    reports: [{ source: 'claude', files: documents.length, locations, notes }],
  };
}

export function defaultAgentHomes(): { codex: string; workbuddy: string; claude: string } {
  return {
    codex: process.env.CODEX_HOME || join(homedir(), '.codex'),
    workbuddy: join(homedir(), '.workbuddy'),
    claude: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
  };
}
