/**
 * WikiSourcePageTree —— 外部来源文档树（勾选）。
 *
 * 后端 `pages` 是**扁平数组**（含目录节点），靠 parentId 表达层级。
 * 直接 map 渲染会把父子平铺成一列，看不出层级，用户会误以为"没有子文档"。
 *
 * 实测规模（真实空间 CSIGCDB）：5748 节点 / 6 层 / 4183 篇文档。
 * 全展开会渲染数千 DOM 导致卡顿，故：
 *   - **默认只展开根级目录**（depth 0 的目录可见其直接子级），深层折叠，按需展开
 *   - 缩进体现层级
 *   - 勾选父目录 = 勾选其下全部后代文档（目录本身不可导入，仅作快捷选择）
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Checkbox } from 'tea-component';
import { ChevronDownIcon, ChevronRightIcon } from 'tea-icons-react';
import type { WikiRemotePageRef } from '@/lib/api/knowledge-api';

interface TreeNode extends WikiRemotePageRef {
  children: TreeNode[];
}

/** 扁平 → 树。parentId 为空/null 即根级；孤儿节点（父不在列表里）也挂到根，避免丢失。 */
function buildTree(pages: WikiRemotePageRef[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  for (const p of pages) nodes.set(p.externalId, { ...p, children: [] });

  const roots: TreeNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.parentId ? nodes.get(n.parentId) : undefined;
    if (parent) parent.children.push(n);
    else roots.push(n);
  }
  return roots;
}

/** 收集某目录下全部非目录后代 id（目录自身不可导入）。 */
function collectLeafIds(node: TreeNode, out: string[] = []): string[] {
  for (const c of node.children) {
    if (c.isDir) collectLeafIds(c, out);
    else out.push(c.externalId);
  }
  return out;
}

/**
 * 默认折叠：depth >= DEFAULT_EXPAND_DEPTH 的目录。
 * 只展开根级目录 → 首屏约「根目录数 + 其直接子」行，大空间也不卡。
 */
const DEFAULT_EXPAND_DEPTH = 1;

function collectDeepDirIds(nodes: TreeNode[], depth = 0, out: string[] = []): string[] {
  for (const n of nodes) {
    if (!n.isDir) continue;
    if (depth >= DEFAULT_EXPAND_DEPTH) out.push(n.externalId);
    collectDeepDirIds(n.children, depth + 1, out);
  }
  return out;
}

function countLeaves(nodes: TreeNode[]): number {
  return nodes.reduce((sum, n) => sum + (n.isDir ? countLeaves(n.children) : 1), 0);
}

function allLeafIds(nodes: TreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.isDir) allLeafIds(n.children, out);
    else out.push(n.externalId);
  }
  return out;
}

export function WikiSourcePageTree({
  pages,
  selectedPageIds,
  onToggleLeaf,
  onToggleDir,
}: {
  pages: WikiRemotePageRef[];
  selectedPageIds: string[];
  /** 勾选/取消单个文档。 */
  onToggleLeaf: (id: string, checked: boolean) => void;
  /** 勾选/取消一批文档（目录快捷全选 / 全选）。 */
  onToggleDir: (ids: string[], checked: boolean) => void;
}) {
  const { t } = useTranslation();
  const tree = useMemo(() => buildTree(pages), [pages]);
  const total = useMemo(() => countLeaves(tree), [tree]);
  const everyLeafId = useMemo(() => allLeafIds(tree), [tree]);
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(collectDeepDirIds(tree)),
  );

  const selectedCount = selectedPageIds.length;
  const allSelected = total > 0 && selectedCount >= total;

  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderNodes = (nodes: TreeNode[], depth: number) =>
    nodes.map((node) => {
      if (!node.isDir) {
        return (
          <div
            key={node.externalId}
            style={{ paddingLeft: depth * 16 + 18, paddingTop: 2, paddingBottom: 2 }}
          >
            <Checkbox
              value={selectedPageIds.includes(node.externalId)}
              onChange={(checked) => onToggleLeaf(node.externalId, checked)}
            >
              {node.title}
            </Checkbox>
          </div>
        );
      }

      const leafIds = collectLeafIds(node);
      const isCollapsed = collapsed.has(node.externalId);
      const dirAllChecked = leafIds.length > 0 && leafIds.every((id) => selectedPageIds.includes(id));

      return (
        <div key={node.externalId}>
          <div style={{ paddingLeft: depth * 16, paddingTop: 2, paddingBottom: 2 }}>
            <span style={{ cursor: 'pointer', marginRight: 4 }} onClick={() => toggleCollapse(node.externalId)}>
              {isCollapsed ? <ChevronRightIcon size={12} /> : <ChevronDownIcon size={12} />}
            </span>
            <Checkbox value={dirAllChecked} onChange={(checked) => onToggleDir(leafIds, checked)}>
              📁 {node.title}
              <span style={{ opacity: 0.5, marginLeft: 6, fontSize: 12 }}>
                {t('wiki.register.dirCount', { count: leafIds.length })}
              </span>
            </Checkbox>
          </div>
          {!isCollapsed && node.children.length > 0 && renderNodes(node.children, depth + 1)}
        </div>
      );
    });

  return (
    <div>
      <div style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>{t('wiki.register.selectPages')}</span>
        <span style={{ opacity: 0.6, fontSize: 12 }}>
          {t('wiki.register.selectedCount', { count: selectedCount, total })}
        </span>
        <Button type="link" onClick={() => onToggleDir(everyLeafId, !allSelected)}>
          {allSelected ? t('common.deselectAll') : t('common.selectAll')}
        </Button>
      </div>
      <div style={{ maxHeight: 300, overflowY: 'auto', border: '1px solid #eee', padding: 8 }}>
        {tree.length === 0 ? (
          <span style={{ opacity: 0.6 }}>{t('wiki.register.emptyTree')}</span>
        ) : (
          renderNodes(tree, 0)
        )}
      </div>
    </div>
  );
}
