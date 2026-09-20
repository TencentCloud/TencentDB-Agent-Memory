/** Wiki-only Markdown transform: preserve code and existing links, and provide anchors. */
type Node = {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
  data?: { hProperties?: Record<string, unknown> };
};

export function remarkWikiLinks() {
  return (tree: Node) => {
    const used = new Map<string, number>();
    const text = (node: Node): string => node.value ?? node.children?.map(text).join('') ?? '';
    const visit = (node: Node) => {
      if (['code', 'inlineCode', 'link', 'linkReference'].includes(node.type)) return;
      if (node.type === 'heading') {
        const slug = text(node).trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
        let id = slug;
        let suffix = used.get(slug) ?? 0;
        while (used.has(id)) id = `${slug}-${++suffix}`;
        used.set(slug, suffix);
        used.set(id, 0);
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id } };
      }
      if (!node.children) return;
      node.children = node.children.flatMap((child): Node[] => {
        if (child.type !== 'text') {
          visit(child);
          return [child];
        }
        const value = child.value ?? '';
        const result: Node[] = [];
        const pattern = /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g;
        let last = 0;
        for (const match of value.matchAll(pattern)) {
          const index = match.index!;
          if (index > last) result.push({ type: 'text', value: value.slice(last, index) });
          result.push({ type: 'link', url: match[1].trim(), children: [{ type: 'text', value: (match[2] || match[1]).trim() }] });
          last = index + match[0].length;
        }
        if (!last) return [child];
        if (last < value.length) result.push({ type: 'text', value: value.slice(last) });
        return result;
      });
    };
    visit(tree);
  };
}
