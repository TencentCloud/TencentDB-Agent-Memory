import assert from 'node:assert/strict';
import test from 'node:test';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { ancestorRefs, buildWikiTree, canonicalWikiRef, resolveWikiLink, wikiHref } from '../src/pages/WikiPage/components/wiki-navigation.ts';
import { remarkWikiLinks } from '../src/pages/WikiPage/components/wiki-markdown.ts';

const pages = ['products/sdk/sdk', 'products/sdk/concepts/anchor', 'products/other/concepts/anchor', 'products/sdk/Space Name']
  .map(ref => ({ path: `wiki/${ref}.md`, title: ref.split('/').at(-1), type: 'concept' }));

test('tree keeps full identities and overview pages separate from folders', () => {
  const tree = buildWikiTree(pages);
  assert.equal(tree[0].path, 'products');
  const sdk = tree[0].children.find(node => node.path === 'products/sdk');
  assert.equal(sdk.children[0].kind, 'folder');
  assert.ok(sdk.children.some(node => node.kind === 'page' && node.ref === 'products/sdk/sdk'));
  const filtered = buildWikiTree(pages, new Set(['products/sdk/concepts/anchor']));
  assert.equal(filtered[0].children.length, 1);
  assert.equal(filtered[0].children[0].children[0].children[0].ref, 'products/sdk/concepts/anchor');
  assert.deepEqual(ancestorRefs('wiki/products/sdk/concepts/anchor.md'), ['products', 'products/sdk', 'products/sdk/concepts']);
});

test('root refs and explicit relative links resolve without basename guessing', () => {
  assert.equal(canonicalWikiRef('wiki/products/sdk/Space Name.md'), 'products/sdk/Space Name');
  for (const href of ['products/sdk/concepts/anchor', '/products/sdk/concepts/anchor.md', 'wiki/products/sdk/concepts/anchor.md', './concepts/anchor.md']) {
    assert.equal(resolveWikiLink(href, 'products/sdk/sdk', pages).page, pages[1]);
  }
  assert.equal(resolveWikiLink('../Space%20Name.md#details', 'products/sdk/concepts/anchor', pages).page, pages[3]);
  assert.equal(resolveWikiLink('../Space%20Name.md#details', 'products/sdk/concepts/anchor', pages).fragment, '#details');
  assert.equal(resolveWikiLink('anchor', 'products/sdk/sdk', pages).page, undefined);
  assert.equal(resolveWikiLink('products/missing', 'products/sdk/sdk', pages).ref, 'products/missing');
});

test('external and invalid links do not resolve to wiki pages', () => {
  for (const href of ['https://example.com/a', '//example.com/a', 'mailto:a@example.com', '#same-page', '../../../sdk', './%ZZ', 'products/../sdk']) {
    assert.equal(resolveWikiLink(href, 'products/sdk/sdk', pages), null, href);
  }
});

test('copied hash-router links retain page and fragment', () => {
  const href = wikiHref('wiki-demo', 'products/sdk/Space Name', '#details');
  const url = new URL(href, 'https://example.com/');
  assert.equal(url.hash, '#/wiki?wiki=wiki-demo&page=products%2Fsdk%2FSpace+Name#details');
});

test('wikilinks preserve code and existing links; headings support Unicode and duplicates', async () => {
  const markdown = '# Hello **world**\n\n# Hello **world**\n\n## 中文 标题\n\n[[products/sdk/sdk|SDK]]\n\n`[[literal]]`\n\n```\n[[literal]]\n```\n\n[existing [[literal]]](https://example.com)';
  const processor = unified().use(remarkParse).use(remarkWikiLinks);
  const tree = await processor.run(processor.parse(markdown));
  assert.deepEqual(tree.children.filter(node => node.type === 'heading').map(node => node.data.hProperties.id), ['hello-world', 'hello-world-1', '中文-标题']);
  const link = tree.children.find(node => node.type === 'paragraph' && node.children[0].type === 'link').children[0];
  assert.equal(link.url, 'products/sdk/sdk');
  assert.equal(link.children[0].value, 'SDK');
  assert.equal(tree.children.find(node => node.type === 'code').value, '[[literal]]');
  const lastLink = tree.children.at(-1).children[0];
  assert.equal(lastLink.children[0].value, 'existing [[literal]]');
});
