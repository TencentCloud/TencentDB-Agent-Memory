export const IMPORT_PLAN_VERSION = 1 as const;
export const MAX_MESSAGE_CHARS = 8_192;
export const MAX_MESSAGES_PER_REQUEST = 100;

export type MemorySource = 'codex' | 'workbuddy' | 'claude';
export type DocumentSplit = 'h2' | 'codex-task-group';

export interface MemoryDocument {
  source: MemorySource;
  sourceLabel: string;
  content: string;
  split: DocumentSplit;
}

export interface ImportMessage {
  role: 'user';
  content: string;
}

export interface ImportSession {
  source: MemorySource;
  session_id: string;
  source_label: string;
  messages: ImportMessage[];
}

export interface ImportPlanV1 {
  version: typeof IMPORT_PLAN_VERSION;
  sources: MemorySource[];
  sessions: ImportSession[];
}

export interface ImportCheckpointV1 {
  version: 1;
  completed: Record<string, { accepted_count: number; imported_at: string }>;
}

interface SourceBlock {
  source: MemorySource;
  sourceLabel: string;
  content: string;
}

/** Stable, non-cryptographic content identifier; it is not used for security. */
export function stableHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    for (const byte of [code & 0xff, code >>> 8]) {
      hash ^= BigInt(byte);
      hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
  }
  return hash.toString(16).padStart(16, '0');
}

function splitDocument(document: MemoryDocument): SourceBlock[] {
  const heading = document.split === 'codex-task-group'
    ? /^#\s+Task Group:\s*(.+?)\s*$/
    : /^##\s+(.+?)\s*$/;
  const lines = document.content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: SourceBlock[] = [];
  let preamble: string[] = [];
  let current: { title: string; lines: string[] } | undefined;

  const flush = () => {
    if (!current) return;
    const content = current.lines.join('\n').trim();
    if (content) {
      blocks.push({
        source: document.source,
        sourceLabel: `${document.sourceLabel}#${current.title}`,
        content,
      });
    }
  };

  for (const line of lines) {
    const match = heading.exec(line);
    if (!match) {
      if (current) current.lines.push(line);
      else preamble.push(line);
      continue;
    }
    flush();
    const prefix = preamble.join('\n').trim();
    current = {
      title: match[1]?.trim() || 'untitled',
      lines: prefix ? [prefix, '', line] : [line],
    };
    preamble = [];
  }

  flush();
  if (blocks.length === 0) {
    const content = preamble.join('\n').trim();
    if (content) {
      blocks.push({ source: document.source, sourceLabel: document.sourceLabel, content });
    }
  }
  return blocks;
}

function splitToFit(content: string, maxChars: number): string[] {
  if (content.length <= maxChars) return [content];
  const chunks: string[] = [];
  let current = '';
  const push = () => {
    if (current) chunks.push(current);
    current = '';
  };

  for (const paragraph of content.split(/\n{2,}/)) {
    const separator = current ? '\n\n' : '';
    if (current.length + separator.length + paragraph.length <= maxChars) {
      current += separator + paragraph;
      continue;
    }
    push();
    if (paragraph.length <= maxChars) {
      current = paragraph;
      continue;
    }
    for (let offset = 0; offset < paragraph.length; offset += maxChars) {
      const slice = paragraph.slice(offset, offset + maxChars);
      if (slice.length === maxChars) chunks.push(slice);
      else current = slice;
    }
  }
  push();
  return chunks;
}

function importedContent(source: MemorySource, sourceLabel: string, body: string): string {
  return `[Imported memory: ${source}/${sourceLabel}]\n\n${body}`;
}

function messagesFor(block: SourceBlock): ImportMessage[] {
  const unsplit = importedContent(block.source, block.sourceLabel, block.content);
  if (unsplit.length <= MAX_MESSAGE_CHARS) return [{ role: 'user', content: unsplit }];

  const reservedLabel = `${block.sourceLabel} [part 9999/9999]`;
  const maxBodyChars = MAX_MESSAGE_CHARS - importedContent(block.source, reservedLabel, '').length;
  if (maxBodyChars < 1) throw new Error(`Source label is too long: ${block.sourceLabel}`);
  const parts = splitToFit(block.content, maxBodyChars);
  if (parts.length > 9_999) throw new Error(`Source block has too many parts: ${block.sourceLabel}`);
  return parts.map((part, index) => ({
    role: 'user',
    content: importedContent(
      block.source,
      `${block.sourceLabel} [part ${index + 1}/${parts.length}]`,
      part,
    ),
  }));
}

export function buildImportPlan(documents: MemoryDocument[]): ImportPlanV1 {
  const sessions = documents.flatMap((document) => {
    const blocks = splitDocument(document);
    if (document.split === 'codex-task-group') {
      return blocks.map((block) => ({
        source: block.source,
        session_id: `import-${block.source}-${stableHash(`${block.sourceLabel}\0${block.content}`)}`,
        source_label: block.sourceLabel,
        messages: messagesFor(block),
      }));
    }
    if (!blocks.length) return [];
    return [{
      source: document.source,
      session_id: `import-${document.source}-${stableHash(`${document.sourceLabel}\0${document.content}`)}`,
      source_label: document.sourceLabel,
      messages: blocks.flatMap(messagesFor),
    }];
  });
  return {
    version: IMPORT_PLAN_VERSION,
    sources: [...new Set(documents.map((document) => document.source))],
    sessions,
  };
}

export function batchMessages<T>(messages: T[], size = MAX_MESSAGES_PER_REQUEST): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error('Batch size must be a positive integer');
  const batches: T[][] = [];
  for (let index = 0; index < messages.length; index += size) {
    batches.push(messages.slice(index, index + size));
  }
  return batches;
}

export function emptyCheckpoint(): ImportCheckpointV1 {
  return { version: 1, completed: {} };
}

export function checkpointKey(
  target: { teamId: string; agentId: string },
  sessionId: string,
  batch: ImportMessage[],
): string {
  return stableHash(JSON.stringify([target.teamId, target.agentId, sessionId, batch]));
}

export function recordSuccessfulBatch(
  checkpoint: ImportCheckpointV1,
  key: string,
  batchLength: number,
  acceptedCount: number,
  importedAt = new Date().toISOString(),
): ImportCheckpointV1 {
  if (acceptedCount !== batchLength) {
    throw new Error(
      `Batch accepted ${acceptedCount}/${batchLength} messages and was not checkpointed; `
        + 'inspect the target before rerunning',
    );
  }
  return {
    version: 1,
    completed: {
      ...checkpoint.completed,
      [key]: { accepted_count: acceptedCount, imported_at: importedAt },
    },
  };
}
