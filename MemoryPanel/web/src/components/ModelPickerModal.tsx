/**
 * ModelPickerModal — 供应商模型列表选择弹窗（P1）。
 *
 * 从供应商 /models 拉回清单后弹出：
 *   - 顶部搜索框（前端本地过滤）
 *   - 多选模式：全选 + checkbox 列表 + 「添加所选」
 *   - 单选模式（向量模型等）：点一个即选
 */
import { useEffect, useMemo, useState } from 'react';
import { Modal, Input, Checkbox, Button, Text, Alert } from 'tea-component';

export interface ModelPickerModalProps {
  visible: boolean;
  models: string[];
  loading?: boolean;
  error?: string;
  /** true = 多选；false = 单选（点一个就确认） */
  multiple?: boolean;
  /** 弹窗打开时的已选清单（多选模式回显） */
  initialSelected?: string[];
  onConfirm: (picked: string[]) => void;
  onClose: () => void;
}

export function ModelPickerModal({
  visible,
  models,
  loading = false,
  error = '',
  multiple = true,
  initialSelected = [],
  onConfirm,
  onClose,
}: ModelPickerModalProps) {
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string[]>([]);

  useEffect(() => {
    if (visible) {
      setPicked(multiple ? [...initialSelected] : []);
      setSearch('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const filtered = useMemo(
    () => models.filter((m) => m.toLowerCase().includes(search.trim().toLowerCase())),
    [models, search],
  );

  const allFilteredChecked = filtered.length > 0 && filtered.every((m) => picked.includes(m));

  const toggle = (m: string) => {
    if (!multiple) {
      onConfirm([m]);
      return;
    }
    setPicked((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));
  };

  const toggleAll = () => {
    if (allFilteredChecked) {
      setPicked((prev) => prev.filter((x) => !filtered.includes(x)));
    } else {
      setPicked((prev) => {
        const next = new Set(prev);
        for (const m of filtered) next.add(m);
        return [...next];
      });
    }
  };

  return (
    <Modal
      visible={visible}
      caption={multiple ? '选择要添加的模型' : '选择模型'}
      onClose={onClose}
      size="m"
    >
      <Modal.Body>
        {error ? (
          <Alert type="error" style={{ marginBottom: 12 }}>
            {error}
          </Alert>
        ) : null}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
          <Input value={search} onChange={setSearch} placeholder="搜索模型" style={{ flex: 1 }} />
          {multiple && filtered.length > 0 ? (
            <Checkbox value={allFilteredChecked} onChange={toggleAll}>
              全选
            </Checkbox>
          ) : null}
        </div>
        <div style={{ maxHeight: 380, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {loading ? <Text theme="weak">正在从供应商拉取模型列表…</Text> : null}
          {!loading && !error && filtered.length === 0 ? (
            <Text theme="weak">{models.length === 0 ? '暂无模型' : '无匹配结果'}</Text>
          ) : null}
          {filtered.map((m) => (
            <Checkbox key={m} value={picked.includes(m)} onChange={() => toggle(m)}>
              <span style={{ fontFamily: 'monospace' }}>{m}</span>
            </Checkbox>
          ))}
        </div>
      </Modal.Body>
      {multiple ? (
        <Modal.Footer>
          <Text theme="weak" style={{ marginRight: 'auto' }}>
            已选 {picked.length} 个
          </Text>
          <Button type="primary" disabled={picked.length === 0} onClick={() => onConfirm(picked)}>
            添加所选
          </Button>
          <Button onClick={onClose}>取消</Button>
        </Modal.Footer>
      ) : null}
    </Modal>
  );
}
