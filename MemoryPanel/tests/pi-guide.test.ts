/**
 * Pi 接入指引纯逻辑测试（issue #1986）。
 *
 * 覆盖：
 *   - Pi 接入地址必须是 `{base}/pi/<instanceId>/v1`（含 analyse 模式的 marker 位置），
 *     与 assets/pi-plugin 的 registerProvider 行为对齐；
 *   - 可复制片段包含 `TDAI_*` 环境变量、载入扩展的 `-e` 与 `--provider tdai`，
 *     且不含真实密钥（只用占位符）；
 *   - 两张清单（Guide 手动配置 / API Key 接入地址）用到的 i18n key 在
 *     zh-CN 与 en-US 里都存在且都非空。
 *
 * 纯 node 环境，无 DOM：只导入 web/src 下的纯 TS 模块（i18n 字典本体，
 * 不导入会初始化 i18next 的 i18n/index.ts）。
 */
import { describe, expect, it } from 'vitest';
import {
  PI_EXTENSION_DIR,
  piEndpoint,
  piSetupSnippet,
  proxyEndpoint,
} from '../web/src/lib/proxyEndpoint.js';
import { zhCN } from '../web/src/i18n/zh-CN.js';
import { enUS } from '../web/src/i18n/en-US.js';

const KEY_PLACEHOLDER = '<your-team-memory-api-key>';

describe('Pi 接入地址', () => {
  it('默认模式以 /pi/<instanceId>/v1 结尾', () => {
    expect(piEndpoint('http://127.0.0.1:8096', 'default')).toBe(
      'http://127.0.0.1:8096/pi/default/v1',
    );
  });

  it('base 结尾的斜杠不会拼出双斜杠', () => {
    expect(piEndpoint('http://127.0.0.1:8096///', 'mem-1')).toBe(
      'http://127.0.0.1:8096/pi/mem-1/v1',
    );
  });

  it('analyse 模式的 marker 位于 /v1 之前（proxy 的 ANALYSE_MARKER_RE 只认 /{a}/{b}/analyse/）', () => {
    expect(piEndpoint('http://h:8096', 'default', 'analyse')).toBe(
      'http://h:8096/pi/default/analyse/v1',
    );
  });

  it('通用 proxyEndpoint 对 pi 走同一规则，对 claude 归一化成 claude-code', () => {
    expect(proxyEndpoint('http://h:8096', 'pi', 'default', 'default')).toBe(
      'http://h:8096/pi/default/v1',
    );
    expect(proxyEndpoint('http://h:8096', 'claude', 'default', 'default')).toBe(
      'http://h:8096/claude-code/default',
    );
    expect(proxyEndpoint('http://h:8096', 'codebuddy', 'default', 'analyse')).toBe(
      'http://h:8096/codebuddy/default/analyse',
    );
  });
});

describe('Pi 接入片段', () => {
  const text = piSetupSnippet('http://127.0.0.1:8096/', 'default', 'glm-5.2-vision', KEY_PLACEHOLDER);

  it('包含 pi-plugin README 列出的 TDAI_* 环境变量', () => {
    for (const key of [
      'TDAI_PROXY_URL',
      'TDAI_SPACE_ID',
      'TDAI_AGENT_SOURCE',
      'TDAI_TEAM_ID',
      'TDAI_AGENT_ID',
      'TDAI_USER_KEY',
      'TDAI_MODEL',
      'TDAI_TASK_ID',
    ]) {
      expect(text).toContain(key);
    }
    expect(text).toContain('TDAI_AGENT_SOURCE=pi');
  });

  it('用 pi -e 载入扩展并以 --provider tdai 启动', () => {
    expect(text).toContain(`-e '${PI_EXTENSION_DIR}'`);
    expect(text).toContain('--provider tdai');
  });

  it('只出现占位符，不出现真实密钥形态', () => {
    expect(text).toContain(KEY_PLACEHOLDER);
    expect(text).not.toMatch(/sk-mem-/);
  });

  it('模型 ID 原样写入（不强制小写）', () => {
    const mixed = piSetupSnippet('http://h', 'd', 'GLM-5.2-Vision/Pro', KEY_PLACEHOLDER);
    expect(mixed).toContain("TDAI_MODEL='GLM-5.2-Vision/Pro'");
  });
});

describe('Pi 文案 i18n', () => {
  const keys = [
    'guide.manual.note.pi.extension',
    'guide.manual.note.pi.v1',
    'guide.manual.note.pi.env',
    'guide.manual.note.pi.history',
    'guide.manual.modelHint.pi',
    'guide.manual.title',
  ];

  it.each(keys)('%s 中英文都存在且非空', (key) => {
    const zh = (zhCN as Record<string, string>)[key];
    const en = (enUS as Record<string, string>)[key];
    expect(typeof zh).toBe('string');
    expect(zh.trim().length).toBeGreaterThan(0);
    expect(typeof en).toBe('string');
    expect(en.trim().length).toBeGreaterThan(0);
  });

  it('两条关键提示都写明了「必须载入扩展」与「地址必须带 /v1」', () => {
    expect((zhCN as Record<string, string>)['guide.manual.note.pi.extension']).toContain('载入扩展');
    expect((zhCN as Record<string, string>)['guide.manual.note.pi.v1']).toContain('/v1');
    expect((enUS as Record<string, string>)['guide.manual.note.pi.extension']).toMatch(/extension must be loaded/i);
    expect((enUS as Record<string, string>)['guide.manual.note.pi.v1']).toContain('/v1');
  });
});