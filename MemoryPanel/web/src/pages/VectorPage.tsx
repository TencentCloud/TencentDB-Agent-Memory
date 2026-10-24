/**
 * VectorPage — 菜单 2「向量检索」。
 *
 * 配置语义向量（embedding）服务：provider / baseURL / apiKey / model。
 *
 * 生效方式：写入 Core 的 tdai-gateway.yaml（写前自动备份、写后回读校验、
 * 失败自动还原），**需要重启 Memory Core 才生效** —— 页面会明确提示这一点，
 * 不做"假装立即生效"的误导。
 */
import { useCallback, useEffect, useState } from 'react';
import { Card, Button, Alert, Text, Justify, H3, Form, Input, Select } from 'tea-component';
import { systemApi, type VectorConfig } from '@/lib/api/system';
import { ModelPickerModal } from '@/components/ModelPickerModal';

const PROVIDER_OPTIONS = [
  { value: 'none', text: '关闭（不启用向量检索）' },
  { value: 'openai', text: 'OpenAI 兼容接口' },
  { value: 'openai-compatible', text: 'OpenAI 兼容（第三方）' },
  { value: 'ollama', text: 'Ollama 本地模型' },
];

export function VectorPage() {
  const [config, setConfig] = useState<VectorConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [provider, setProvider] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  /** 用户输入的完整 Key；后端返回的是脱敏值，绝不回填到这里（含 • 的值进 fetch 头会抛 ByteString） */
  const [apiKey, setApiKey] = useState('');
  /** 仅用于展示的脱敏 Key（提示用户已保存过） */
  const [maskedApiKey, setMaskedApiKey] = useState('');
  const [dimensions, setDimensions] = useState('');

  // P1：从供应商拉取向量模型列表（单选弹窗）
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerModels, setPickerModels] = useState<string[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState('');

  const fetchModels = async () => {
    if (!baseUrl) {
      setPickerError('请先填写服务地址');
      setPickerVisible(true);
      return;
    }
    // 已保存的 Key 是脱敏回显（含 •），拿不到明文 —— 必须让用户重输
    if (!apiKey && maskedApiKey) {
      setPickerError('已保存的 API Key 为脱敏显示（' + maskedApiKey + '），请先在下方重新输入完整 Key，再获取模型列表');
      setPickerVisible(true);
      return;
    }
    if (!apiKey) {
      setPickerError('请先填写 API Key（部分供应商的模型列表接口需要鉴权）');
      setPickerVisible(true);
      return;
    }
    setPickerVisible(true);
    setPickerLoading(true);
    setPickerError('');
    setPickerModels([]);
    try {
      const result = await systemApi.listUpstreamModels({
        base_url: baseUrl,
        api_key: apiKey,
        protocol: 'openai-chat',
      });
      if (result.ok) {
        setPickerModels(result.models);
        if (result.models.length === 0) setPickerError('供应商返回了空模型列表');
      } else {
        setPickerError(result.error || '拉取失败');
      }
    } catch (err) {
      setPickerError(err instanceof Error ? err.message : String(err));
    } finally {
      setPickerLoading(false);
    }
  };

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await systemApi.vector();
      setConfig(data);
      setProvider(data.provider || 'none');
      setBaseUrl(data.baseUrl || '');
      setModel(data.model || '');
      setApiKey('');
      setMaskedApiKey(data.apiKey || '');
      setDimensions(data.dimensions || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async () => {
    setSaving(true);
    setError('');
    setSaved(null);
    try {
      const result = await systemApi.saveVector({
        provider,
        baseUrl,
        model,
        apiKey,
        dimensions,
      });
      setSaved(`${result.restartHint}（备份：${result.backupPath}）`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: 20 }}>
      <Justify
        left={
          <div>
            <H3>向量检索</H3>
            <Text theme="weak">配置语义向量的模型服务，用于记忆的语义召回。</Text>
          </div>
        }
      />

      {error ? (
        <Alert type="error" style={{ marginTop: 12 }}>
          {error}
        </Alert>
      ) : null}
      {saved ? (
        <Alert type="success" style={{ marginTop: 12 }}>
          {saved}
        </Alert>
      ) : null}

      <Card style={{ marginTop: 16 }}>
        <Card.Body title="Embedding 配置">
          {loading ? (
            <Text theme="weak">加载中…</Text>
          ) : (
            <Form>
              <Form.Item label="Provider">
                <Select
                  appearance="button"
                  options={PROVIDER_OPTIONS}
                  value={provider}
                  onChange={(value) => setProvider(value as string)}
                />
              </Form.Item>
              <Form.Item label="服务地址">
                <Input
                  value={baseUrl}
                  onChange={(value) => setBaseUrl(value)}
                  placeholder="http://127.0.0.1:11434/v1"
                />
              </Form.Item>
              <Form.Item label="模型">
                <div style={{ display: 'flex', gap: 8 }}>
                  <Input
                    value={model}
                    onChange={(value) => setModel(value)}
                    placeholder="bge-m3 / text-embedding-3-small"
                    style={{ flex: 1 }}
                  />
                  <Button onClick={() => void fetchModels()}>从供应商获取</Button>
                </div>
              </Form.Item>
              <Form.Item label="API Key">
                <Input
                  value={apiKey}
                  onChange={(value) => setApiKey(value)}
                  placeholder={maskedApiKey ? `留空 = 沿用已保存的 Key（${maskedApiKey}）` : 'sk-...'}
                />
              </Form.Item>
              <Form.Item label="维度">
                <Input value={dimensions} onChange={(value) => setDimensions(value)} placeholder="1024" />
              </Form.Item>
            </Form>
          )}

          {config ? (
            <Text theme="weak" style={{ display: 'block', marginTop: 8 }}>
              配置文件：{config.path}
            </Text>
          ) : null}

          <div style={{ marginTop: 16 }}>
            <Button type="primary" onClick={() => void save()} loading={saving}>
              保存
            </Button>
            <Button style={{ marginLeft: 8 }} onClick={() => void refresh()}>
              重新读取
            </Button>
          </div>

          <Alert type="warning" style={{ marginTop: 16 }}>
            向量配置<b>必须重启 Memory Core 才生效</b>。保存接口已做「写前备份 → 写后回读校验 →
            失败自动还原」，保存失败不会留下半截配置。
          </Alert>
        </Card.Body>
      </Card>

      <ModelPickerModal
        visible={pickerVisible}
        models={pickerModels}
        loading={pickerLoading}
        error={pickerError}
        multiple={false}
        onClose={() => setPickerVisible(false)}
        onConfirm={(picked) => {
          if (picked[0]) setModel(picked[0]);
          setPickerVisible(false);
        }}
      />
    </div>
  );
}
