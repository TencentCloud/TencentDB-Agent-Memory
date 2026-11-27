/** Only explicit CodeGraph error codes can identify the index state. */
import type { CodeGraphQueryResult } from '@/lib/api/knowledge-api';

export interface CodeGraphServedIndex {
  commitHash: string | null;
  lastSyncAt: string | null;
}

/** Use the query response itself: list metadata may have changed after this result was served. */
export function codeGraphServedIndex(result: CodeGraphQueryResult): CodeGraphServedIndex | null {
  if (result.stale !== true) return null;
  return {
    commitHash: result.served_commit_hash ?? null,
    lastSyncAt: result.last_sync_at ?? null,
  };
}

export function codeGraphQueryFailureMessage(
  error: unknown,
  translate: (key: string) => string,
): string | null {
  if (typeof error !== 'object' || error === null || !('errorCode' in error)) return null;

  switch (error.errorCode) {
    case 'CODE_GRAPH_INDEX_BUILDING':
      return translate('code.notify.queryBuilding');
    case 'CODE_GRAPH_INDEX_SWITCHING':
      return translate('code.notify.querySwitching');
    case 'CODE_GRAPH_INDEX_UNAVAILABLE':
      return translate('code.notify.queryUnavailable');
    case 'CODE_GRAPH_INDEX_FAILED':
      return translate('code.notify.queryFailed');
    default:
      return null;
  }
}
