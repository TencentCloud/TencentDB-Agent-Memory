/**
 * i18n 资源对齐用例。
 *
 * 面板的 i18n 是扁平点号 key 的单层对象，漏翻时 i18next 会静默回退到
 * zh-CN（缺失英文时界面直接出现中文），不报错也不影响构建 —— 只能靠测试拦。
 *
 * 三条断言：
 *   1. 两个语言的 key 集合完全一致（比较差集，失败时只打印缺的几条）；
 *   2. 所有文案非空白；
 *   3. 同一 key 的 {{插值变量}} 集合一致（防止翻译时写错变量名导致渲染出字面量）。
 *
 * 注意：直接 import 资源对象，不 import `../index` —— 后者会初始化 i18next
 * 并读写 localStorage，在 jsdom 下属于无谓副作用。
 */
import { describe, expect, it } from 'vitest';
import { zhCN } from '../zh-CN';
import { enUS } from '../en-US';

const zh = zhCN as Record<string, string>;
const en = enUS as Record<string, string>;

const zhKeys = Object.keys(zh);
const enKeys = Object.keys(en);

const hasOwn = (target: Record<string, string>, key: string) =>
  Object.prototype.hasOwnProperty.call(target, key);

/** 提取 {{var}} 变量名并排序拼接；用于比较两语言插值是否一致。 */
function placeholders(text: string): string {
  return [...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)]
    .map((match) => match[1])
    .sort()
    .join(',');
}

describe('i18n 资源对齐', () => {
  it('zh-CN 与 en-US 的 key 集合完全一致', () => {
    const missingInEn = zhKeys.filter((key) => !hasOwn(en, key)).sort();
    const missingInZh = enKeys.filter((key) => !hasOwn(zh, key)).sort();

    expect({ missingInEn, missingInZh }).toEqual({ missingInEn: [], missingInZh: [] });
  });

  it('所有文案非空白', () => {
    const empties = [...zhKeys, ...enKeys].filter((key) => {
      const value = hasOwn(zh, key) ? zh[key] : en[key];
      return typeof value !== 'string' || value.trim() === '';
    });

    expect(empties).toEqual([]);
  });

  it('同一 key 的插值变量集合一致', () => {
    const mismatched = zhKeys
      .filter((key) => hasOwn(en, key))
      .filter((key) => placeholders(zh[key]) !== placeholders(en[key]))
      .map((key) => ({
        key,
        zh: placeholders(zh[key]),
        en: placeholders(en[key]),
      }));

    expect(mismatched).toEqual([]);
  });
});
