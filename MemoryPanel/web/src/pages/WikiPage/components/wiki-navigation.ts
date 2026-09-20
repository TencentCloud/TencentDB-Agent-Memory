import type { WikiPage } from '@/lib/api/knowledge-api';

export type WikiTreeNode =
  | { kind: 'folder'; name: string; path: string; children: WikiTreeNode[] }
  | { kind: 'page'; page: WikiPage; ref: string };

/** The stable identity used by wiki links and the page tree. */
export function canonicalWikiRef(value: string): string {
  let ref = value.trim().replaceAll('\\', '/');
  ref = ref.replace(/^\/+/, '').replace(/^wiki\//, '');
  ref = ref.split(/[?#]/, 1)[0];
  if (ref.toLowerCase().endsWith('.md')) ref = ref.slice(0, -3);
  return ref.replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/\.\//g, '/');
}

export function pageRef(page: WikiPage): string {
  return canonicalWikiRef(page.path);
}

export function pageKey(page: WikiPage): string {
  return (page as any).id || page.path;
}

export function pageByRef(pages: readonly WikiPage[]): Map<string, WikiPage> {
  return new Map(pages.map((page) => [pageRef(page), page]));
}

/** Build virtual folders from canonical paths. A page is never merged into a folder. */
export function buildWikiTree(
  pages: readonly WikiPage[],
  visibleRefs?: ReadonlySet<string>,
): WikiTreeNode[] {
  type Branch = { folders: Map<string, Branch>; pages: Array<{ page: WikiPage; ref: string }> };
  const root: Branch = { folders: new Map(), pages: [] };
  for (const page of pages) {
    const ref = pageRef(page);
    if (!ref || (visibleRefs && !visibleRefs.has(ref))) continue;
    const parts = ref.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    let branch = root;
    for (const folder of parts.slice(0, -1)) {
      let child = branch.folders.get(folder);
      if (!child) {
        child = { folders: new Map(), pages: [] };
        branch.folders.set(folder, child);
      }
      branch = child;
    }
    branch.pages.push({ page, ref });
  }
  const render = (branch: Branch, parent = ''): WikiTreeNode[] => {
    const folders = [...branch.folders.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, child]) => ({
        kind: 'folder' as const,
        name,
        path: parent ? `${parent}/${name}` : name,
        children: render(child, parent ? `${parent}/${name}` : name),
      }));
    const pageNodes = [...branch.pages]
      .sort((a, b) => a.page.title.localeCompare(b.page.title) || a.ref.localeCompare(b.ref))
      .map(({ page, ref }) => ({ kind: 'page' as const, page, ref }));
    return [...folders, ...pageNodes];
  };
  return render(root);
}

export function ancestorRefs(ref: string): string[] {
  const parts = canonicalWikiRef(ref).split('/').filter(Boolean);
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}

function isExternalHref(href: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href);
}

/** Resolve a root-relative, aliased, or explicit relative Markdown link. */
export function resolveWikiLink(
  href: string,
  currentRef: string,
  pages: readonly WikiPage[],
): { ref: string; fragment?: string; page?: WikiPage } | null {
  const raw = href.trim();
  if (!raw || raw.startsWith('#') || isExternalHref(raw)) return null;
  const hashAt = raw.indexOf('#');
  const fragment = hashAt >= 0 ? raw.slice(hashAt) : undefined;
  const withoutFragment = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
  let candidate: string;
  if (withoutFragment.startsWith('./') || withoutFragment.startsWith('../')) {
    const base = canonicalWikiRef(currentRef).split('/').slice(0, -1);
    for (const encodedPart of withoutFragment.split('/')) {
      let part: string;
      try {
        part = decodeURIComponent(encodedPart);
      } catch {
        return null;
      }
      if (!part || part === '.') continue;
      if (part === '..') {
        if (base.length === 0) return null;
        base.pop();
      }
      else base.push(part);
    }
    candidate = base.join('/');
  } else {
    try {
      candidate = decodeURIComponent(withoutFragment.replace(/^\/+/, ''));
    } catch {
      return null;
    }
  }
  const ref = canonicalWikiRef(candidate);
  if (!ref || ref.split('/').includes('..')) return null;
  const page = pageByRef(pages).get(ref);
  return { ref, fragment, page };
}

export function wikiHref(wikiId: string, ref: string, fragment?: string): string {
  const params = new URLSearchParams({ wiki: wikiId, page: ref });
  return `#/wiki?${params.toString()}${fragment || ''}`;
}
