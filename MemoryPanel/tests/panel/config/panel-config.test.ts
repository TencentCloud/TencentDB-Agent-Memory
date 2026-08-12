import { afterEach, describe, expect, it } from 'vitest';
import { loadPanelConfig } from '../../../src/panel/config/panel-config.js';

const keys = [
  'PORT',
  'METADATA_REMOTE_TIMEOUT_MS',
  'KNOWLEDGE_TIMEOUT_MS',
  'EVALUATION_BUNDLE_ENABLED',
  'EVALUATION_BUNDLE_PATH',
  'EVALUATION_BUNDLE_EXPECTED_SHA256',
  'EVALUATION_BUNDLE_MAX_BYTES',
];
afterEach(() => keys.forEach((key) => delete process.env[key]));

describe('evaluation config', () => {
  it('默认关闭，不影响 Panel 启动和健康检查', () => {
    expect(loadPanelConfig().evaluation).toMatchObject({ enabled: false, mode: 'bundled', maxBytes: 10 * 1024 * 1024 });
  });

  it('从显式环境变量读取服务端路径和大小门禁', () => {
    process.env.EVALUATION_BUNDLE_ENABLED = '1';
    process.env.EVALUATION_BUNDLE_PATH = '/app/evaluation/bundle/evaluation-view-bundle.json';
    process.env.EVALUATION_BUNDLE_EXPECTED_SHA256 = `sha256:${'a'.repeat(64)}`;
    process.env.EVALUATION_BUNDLE_MAX_BYTES = '4096';
    expect(loadPanelConfig().evaluation).toEqual({
      enabled: true, mode: 'bundled', maxBytes: 4096,
      bundlePath: '/app/evaluation/bundle/evaluation-view-bundle.json',
      expectedSha256: `sha256:${'a'.repeat(64)}`,
    });
  });

  it('拒绝非正整数大小配置并回落到安全默认值', () => {
    process.env.EVALUATION_BUNDLE_MAX_BYTES = '-1';
    expect(loadPanelConfig().evaluation.maxBytes).toBe(10 * 1024 * 1024);
  });

  it('不改变既有整数配置接受零值的语义', () => {
    process.env.PORT = '0';
    process.env.METADATA_REMOTE_TIMEOUT_MS = '0';
    process.env.KNOWLEDGE_TIMEOUT_MS = '0';
    const config = loadPanelConfig();
    expect(config.server.port).toBe(0);
    expect(config.metadataRemoteTimeoutMs).toBe(0);
    expect(config.knowledge.timeoutMs).toBe(0);
  });
});
