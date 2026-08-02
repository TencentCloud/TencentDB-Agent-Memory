/**
 * TaskCreateDialog — 按 PRD §7 实现的「新建 Task」弹窗。
 *
 * Tea 组件重构版：底层复用全站统一的 `./Modal`（Tea Modal），
 * 输入控件换成 Tea `Input`/`Input.TextArea`，错误提示换成 Tea `Alert`。
 *
 * 必填字段（前端校验）：
 *   - title         任务标题
 *   - description   任务描述
 *
 * 关于 team 归属：
 *   不再让用户在 dialog 里选 team。team 由右上角全局 TeamSwitcher 决定，
 *   这里只 readonly 展示「将创建到 team：name (team_id)」，避免出现「右上角是 A
 *   但弹窗里默认选了 B、用户没注意一切就走偏」的两套上下文不一致问题。
 *
 * 不再在创建时选 Agent — 关联 Agent 放到 task 创建之后再做。
 *
 * 演示阶段：直接通过 onCreate 把表单数据交回父组件由父组件保存到 localStorage。
 * 后端 /tasks API 上线后，把父组件的 onCreate 改成 fetch POST 即可。
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Tag, Input, Button, Form, Modal } from 'tea-component';
import './task-create-dialog.css';

export type TaskSourceType = 'manual' | 'tapd';

export interface TaskDraft {
  team_id: string;
  title: string;
  description: string;
  source_type: TaskSourceType;
  source_url: string;
  linked_agents: string[];
}

export default function TaskCreateDialog(props: {
  team: { team_id: string; name: string };
  onClose: () => void;
  onCreate: (draft: TaskDraft) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = title.trim().length > 0 && description.trim().length > 0;

  async function submit() {
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      await props.onCreate({
        team_id: props.team.team_id,
        title: title.trim(),
        description: description.trim(),
        source_type: 'manual',
        source_url: '',
        linked_agents: [],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <Modal visible caption={t('workbench.createTask', { defaultValue: '新建 Task' })} size="m" onClose={props.onClose} disableEscape={submitting}>
      <Modal.Body>
        <Form>
          <Form.Item label={t('header.currentTeam', { defaultValue: '所属 Team' })}>
            <div className="_memory-tcd-team-row">
              <span className="_memory-tcd-team-avatar">{props.team.name.slice(0, 1).toUpperCase()}</span>
              <div className="_memory-tcd-team-meta">
                <div className="_memory-tcd-team-label">{t('team.switchDesc', { defaultValue: '将创建到 team' })}</div>
                <div className="_memory-tcd-team-name-row">
                  <span className="_memory-tcd-team-name">{props.team.name}</span>
                  <Tag size="sm">{props.team.team_id}</Tag>
                </div>
              </div>
            </div>
          </Form.Item>
          <Form.Item label={t('workbench.taskName', { defaultValue: '标题' })} required>
            <Input
              autoFocus
              size="full"
              value={title}
              onChange={setTitle}
              placeholder={t('workbench.taskName', { defaultValue: '例如：修复 #142 macOS 14 启动失败' })}
            />
          </Form.Item>
          <Form.Item label={t('common.description', { defaultValue: '描述' })} required extra={t('team.agents.noAssets', { defaultValue: '关联 Agent 可在创建后再挂载' })}>
            <Input.TextArea
              size="full"
              value={description}
              onChange={setDescription}
              rows={4}
              placeholder={t('common.description', { defaultValue: '包含背景、目标、验收标准。建议越具体越好，方便 agent 理解上下文。' })}
            />
          </Form.Item>
          {error && <Form.Item><Alert type="error">{error}</Alert></Form.Item>}
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" onClick={() => void submit()} disabled={!canSubmit} loading={submitting}>{t('workbench.createTask', { defaultValue: '创建 Task' })}</Button>
        <Button onClick={props.onClose} disabled={submitting}>{t('common.cancel', { defaultValue: '取消' })}</Button>
      </Modal.Footer>
    </Modal>
  );
}
