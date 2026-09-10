/** Protocols used by the existing Panel connection recipes and Pi adapter. */
export const UPSTREAM_CLIENTS = [
  { id: 'claude-code', name: 'Claude Code', protocols: ['anthropic'] },
  { id: 'codebuddy', name: 'CodeBuddy', protocols: ['chat'] },
  { id: 'codex', name: 'Codex', protocols: ['responses'] },
  { id: 'workbuddy', name: 'WorkBuddy', protocols: ['chat', 'responses'] },
  { id: 'dsh', name: 'DeepSeek Harness', protocols: ['chat'] },
  { id: 'opencode', name: 'OpenCode', protocols: ['chat'] },
  { id: 'hermes', name: 'Hermes', protocols: ['chat'] },
  { id: 'openclaw', name: 'OpenClaw', protocols: ['chat'] },
  { id: 'pi', name: 'Pi', protocols: ['chat'] },
] as const;

// Official API prefixes (not full endpoint URLs); no protocol conversion.
// https://cloud.tencent.com/document/product/1823/130079
// https://cloud.tencent.com/document/product/1729/127293
// https://api-docs.deepseek.com/guides/anthropic_api/
// https://docs.bigmodel.cn/cn/guide/develop/claude
export const UPSTREAM_PROVIDERS = [
  { id: 'tencent', name: 'Tencent TokenHub', anthropic: 'https://tokenhub.tencentmaas.com/v1', chat: 'https://tokenhub.tencentmaas.com/v1', model: '' },
  { id: 'hunyuan', name: 'Tencent Hunyuan', anthropic: 'https://api.hunyuan.cloud.tencent.com/anthropic/v1', chat: 'https://api.hunyuan.cloud.tencent.com/v1', model: 'hunyuan-2.0-instruct-20251111' },
  { id: 'deepseek', name: 'DeepSeek', anthropic: 'https://api.deepseek.com/anthropic/v1', chat: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
  { id: 'zhipu', name: 'Zhipu', anthropic: 'https://open.bigmodel.cn/api/anthropic/v1', chat: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5' },
] as const;
