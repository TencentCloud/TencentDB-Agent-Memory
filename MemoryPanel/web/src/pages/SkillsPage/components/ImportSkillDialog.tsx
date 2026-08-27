/**
 * ImportSkillDialog — 导入 Skill 弹窗。仅支持两种导入方式：
 *
 *   1. 目录导入（directory）
 *      用户选一个本地目录，前端把里面的 File 拆成「主文件」（SKILL.md，
 *      必须在根目录或 <skill-name>/ 下）和「资源文件」（其他文件，保留
 *      相对路径）。走 v3 create 一次性落库（含资源，新建即 v1）。
 *      浏览器目录选择无 Tea 组件等价物，保留原生 <input type="file"
 *      webkitdirectory>，隐藏后由 Tea Button 触发。
 *
 *   2. 对话导入（session）
 *      用户粘贴一段与该 agent 的对话（skill/extract 接口入参 JSON，
 *      含 messages 数组）。前端只做 JSON 校验 + 用当前上下文 ID 覆盖
 *      身份字段，然后调 extractSkills。服务端 LLM 从对话里自动归纳
 *      skill 的 name / description / content，通过工具调用直接落库
 *      （走 SkillCore.create/update 同一条链路），不经过审核。
 *      支持 sync（直接返回结果）和 async（返回 task_id 即视为已受理，
 *      提示用户预计出结果时间后关闭弹窗，不在前端阻塞轮询 —— 结果会异步
 *      沉淀到该 agent 的 skill 列表，用户后续手动刷新即可看到）。
 *
 * 移除说明：原有的「粘贴 SKILL.md 文本」模式已下线 —— 目录导入已覆盖
 * 该场景，且用户手写 frontmatter 极易踩坑（name/description 缺失、
 * YAML 语法错），改由目录导入引导用户放好 SKILL.md 更稳。
 */

import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  createSkill,
  extractSkills,
  type SkillResourcePayload,
  type ExtractParams,
} from '@/lib/api/skill-api';
import { Alert, Button, Form, Input, Modal, Segment, Select } from 'tea-component';
import { FolderOpenIcon } from 'tea-icons-react';
import i18n from '@/i18n';
import '../styles/import-skill-dialog.css';

type Mode = 'directory' | 'session';

/**
 * Read a File as base64. Used for binary/executable resources where we
 * can't safely treat bytes as utf8.
 */
async function readAsBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  // Browser-side base64: chunked to avoid stack-overflow on big files.
  let bin = '';
  const arr = new Uint8Array(buf);
  const chunk = 8192;
  for (let i = 0; i < arr.length; i += chunk) {
    bin += String.fromCharCode(...arr.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function readAsUtf8(file: File): Promise<string> {
  return file.text();
}

/**
 * Heuristic: extension-based + small-size = text. The gateway already
 * enforces a 5MB cap, but we want to send big binaries as base64 not
 * as a 5MB-of-mojibake string.
 */
function looksLikeText(file: File): boolean {
  const lower = file.name.toLowerCase();
  if (/\.(md|markdown|txt|json|yaml|yml|sh|js|ts|tsx|py|go|rs|toml|html|css|csv|conf|cfg)$/.test(lower)) {
    return true;
  }
  if (file.size < 64 * 1024) return true;
  return false;
}

/**
 * Walk webkitRelativePath like "my-skill/SKILL.md" or "my-skill/files/scripts/x.sh".
 * Returns { skillName, mainFile, resources }; resource paths are
 * normalised relative to `<skill-name>/files/`.
 */
function partitionFiles(files: File[]): {
  skillName: string | null;
  mainFile: File | null;
  resources: Array<{ path: string; file: File }>;
  warning?: string;
} {
  let mainFile: File | null = null;
  let mainRelPath = '';
  for (const f of files) {
    const rel = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
    const segments = rel.split('/');
    const lastSegment = segments[segments.length - 1] ?? '';
    if (lastSegment === 'SKILL.md') {
      // Prefer the shallowest SKILL.md (depth = number of segments).
      if (!mainFile || segments.length < mainRelPath.split('/').length) {
        mainFile = f;
        mainRelPath = rel;
      }
    }
  }
  if (!mainFile) {
    return {
      skillName: null,
      mainFile: null,
      resources: [],
      warning: i18n.t('importSkill.directory.warning'),
    };
  }
  const mainSegments = mainRelPath.split('/');
  const baseDir = mainSegments.slice(0, -1).join('/');
  const skillName = mainSegments.length >= 2 ? mainSegments[mainSegments.length - 2] : null;

  const resources: Array<{ path: string; file: File }> = [];
  for (const f of files) {
    if (f === mainFile) continue;
    let rel = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
    if (baseDir && rel.startsWith(baseDir + '/')) {
      rel = rel.slice(baseDir.length + 1);
    }
    if (rel.startsWith('files/')) rel = rel.slice('files/'.length);
    if (!rel) continue;
    resources.push({ path: rel, file: f });
  }
  return { skillName, mainFile, resources };
}

export default function ImportSkillDialog(props: {
  onClose: () => void;
  onImported: () => void;
  /** 当前激活 team（skill 归属，create 必填） */
  teamId: string;
  /** Import target: 'team' = team pool (default), 'fixed' = agent fixed assets. */
  target?: 'team' | 'fixed';
  /** Agent roster (for fixed-target agent selector). */
  agents?: Array<{ id: string; name: string }>;
  /** Pre-selected agent id (when target='fixed'). */
  agentId?: string;
  /** 当前用户 ID（v3 API 必传） */
  userId: string;
}) {
  const [mode, setMode] = useState<Mode>('directory');
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  // session-import：用户粘贴 skill/extract 接口入参（含 messages 数组）。
  // 服务端 LLM 从 messages 自行归纳 skill 的 name / description / content。
  const [sessionPayload, setSessionPayload] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string>(props.agentId ?? '');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();

  const partition = useMemo(() => (mode === 'directory' ? partitionFiles(pickedFiles) : null), [
    mode,
    pickedFiles
  ]);

  async function submit(): Promise<void> {
    setError(null);
    setResult(null);
    setSubmitting(true);
    try {
      const agentId = props.target === 'fixed' ? (selectedAgentId || props.agentId || '') : '';
      if (props.target === 'fixed' && !agentId) {
        throw new Error(t('importSkill.error.noAgent'));
      }
      if (!props.teamId) throw new Error(t('importSkill.error.noTeam'));

      // ==== 对话导入：直接调 skill/extract ====
      if (mode === 'session') {
        const raw = sessionPayload.trim();
        if (!raw) throw new Error(t('importSkill.error.noPayload'));
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          throw new Error(t('importSkill.error.jsonParse', { msg: e instanceof Error ? e.message : String(e) }));
        }
        if (!Array.isArray((parsed as { messages?: unknown }).messages)) {
          throw new Error(t('importSkill.error.noMessages'));
        }
        const msgs = (parsed as { messages: unknown[] }).messages;
        if (msgs.length === 0) {
          throw new Error(t('importSkill.error.emptyMessages'));
        }
        // 后端 extract 接口限制 messages 最多 500 条（见 iWiki §3.13），
        if (msgs.length > 500) {
          throw new Error(t('importSkill.error.tooManyMessages', { count: msgs.length }));
        }

        // 组装 extract 入参。身份字段（user_id/team_id/agent_id）强制用当前 UI
        // 上下文覆盖，避免用户粘错 team / 伪造他人身份 —— 参见 <security_rules> §3。
        // space_id 不需要显式传：跟其他 skill 接口一致, 后端从 X-Tdai-Service-Id
        // header (= panelSession.instanceId) 取。session_id / task_id 也不传,
        // 让后端生成 —— 避免前端硬编码 "default" / "import-${Date.now()}" 污染归档路径。
        // extract 接口本身不接受 name/description 字段（skill 名和描述由 LLM
        // 从 messages 中自行归纳），JSON 中即便带了这两个字段也不会透传给服务端。
        const extractParams: ExtractParams = {
          user_id: props.userId,
          team_id: props.teamId,
          agent_id: agentId || props.userId,
          task_id: typeof parsed.task_id === 'string' && parsed.task_id ? parsed.task_id : undefined,
          session_id:
            typeof parsed.session_id === 'string' && parsed.session_id
              ? parsed.session_id
              : undefined,
          messages: parsed.messages as ExtractParams['messages'],
          reason:
            typeof parsed.reason === 'string' && parsed.reason
              ? parsed.reason
              : 'manual import from console',
          options:
            typeof parsed.options === 'object' && parsed.options !== null
              ? (parsed.options as ExtractParams['options'])
              : undefined,
        };

        // 后端 extract 恒走 archive → agent 队列 → worker 异步链路,
        // 永远返回 task_id (没有 sync candidates 分支了)。前端拿到 task_id 即
        // 视为"已受理"，提示预计出结果时间后关闭弹窗；结果由 SkillCoreSink 异步
        // 写入 skill 表，用户回列表刷新即可看到。
        //
        // 前端软超时兜底（5s）：archive 链路涉及 COS 顺序读写（读 _tasks.json →
        // 写 data-xxx.jsonl → 写 _tasks.json），当 COS 慢时整体耗时容易超过
        // Panel 后端 15s 硬超时（KERNEL_TIMEOUT/504），从而在 UI 上误报失败。
        // 实际上请求已经在服务端排入队列，后端会继续跑完 archive。因此这里
        // 5s 内后端有响应就按真结果走；5s 到点还没回就直接展示"已受理"文案，
        // 不再阻塞用户 —— 后端调用在浏览器 fetch 层继续跑（不 abort），最坏
        // 情况是 15s 后 Panel 回 504，我们的 catch 静默吞掉（用户已经看到成功了）。
        const TIMEOUT_MS = 5000;
        let softTimedOut = false;
        const extractPromise = extractSkills(extractParams).catch((e) => {
          // 如果已经软超时展示了成功文案，这里就静默吞掉后续错误（504 等）。
          if (softTimedOut) return null;
          throw e;
        });
        const timeoutPromise = new Promise<'timeout'>((resolve) =>
          setTimeout(() => resolve('timeout'), TIMEOUT_MS),
        );
        const raced = await Promise.race([extractPromise, timeoutPromise]);
        if (raced === 'timeout') {
          softTimedOut = true;
          setResult(t('importSkill.result.session.accepted'));
        } else if (raced) {
          setResult(t('importSkill.result.session', { taskId: raced.task_id }));
        } else {
          // extractPromise 被软超时后 catch 成 null 的分支（正常不会走到这里，
          // 因为软超时已经先设过 result 了），兜底保持一致文案。
          setResult(t('importSkill.result.session.accepted'));
        }
        setTimeout(() => props.onImported(), 1500);
        return;
      }

      // ==== 目录导入：走 v3 create + files/write ====
      if (!partition?.mainFile) {
        throw new Error(partition?.warning ?? t('importSkill.error.noMainFile'));
      }
      const content = await readAsUtf8(partition.mainFile);
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      const nameMatch = fmMatch?.[1].match(/^name:\s*(.+)$/m);
      const name = nameMatch?.[1].trim().replace(/^["']|["']$/g, '') || partition.skillName || '';
      if (!name) {
        throw new Error(t('importSkill.error.noName'));
      }
      const resourceFiles: { path: string; file: File; isBinary: boolean }[] = partition.resources.map(
        ({ path, file }) => ({ path, file, isBinary: !looksLikeText(file) }),
      );

      // 确保 content 以 `---\n` 开头（v3 frontmatter 格式要求）。
      const safeContent = content.trimStart().startsWith('---') ? content : `---\nname: ${name}\n---\n\n${content}`;

      // 资源文件随 create 一次性落库（单版本 v1）。
      // 修复：原实现是 create(resources=[] → v1) + files/write(→ v2) 两步，
      // 导致任何带资源的导入 skill 一落库就是 v2（version 语义错乱）。
      // v3 create 本身支持 resources 数组，合并为一次调用即可保证新建 skill = v1。
      const resources: SkillResourcePayload[] = resourceFiles.length > 0
        ? await Promise.all(
            resourceFiles.map(async ({ path, file, isBinary }) =>
              isBinary
                ? { path, content: await readAsBase64(file), encoding: 'base64' as const }
                : { path, content: await readAsUtf8(file), encoding: 'utf-8' as const },
            ),
          )
        : [];

      await createSkill({
        user_id: props.userId,
        team_id: props.teamId,
        agent_id: agentId || props.userId, // v3 要求 agent_id，固定模式用选中的，否则用 userId 兜底
        name,
        content: safeContent,
        resources: resources.length ? resources : undefined,
      });

      setResult(t('importSkill.result.directory', { name, count: resourceFiles.length }));
      setTimeout(() => props.onImported(), 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  // 是否需要在弹窗内显示「归属 Agent」选择器：
  //   - 仅 fixed-target 才有 agent 归属概念
  //   - 必须传了 agents 才能渲染下拉
  const showAgentPicker = props.target === 'fixed' && !!props.agents;

  return (
    <Modal visible caption={t('importSkill.caption')} size="l" onClose={props.onClose} disableEscape={submitting}>
      <Modal.Body>
        <Alert type="info">{t('importSkill.hint')}</Alert>
      {/* 归属 Agent —— 必选项。始终展示在导入方式上方，
          与 ChatMemoryPanel.ImportBlockDialog 一致：即便外层已经传了 agentId
          也允许在弹窗里重选。 */}
      {showAgentPicker && (
        <Form layout="vertical" style={{ width: '100%' }}>
          <Form.Item
            label={t('importSkill.agent')}
            extra={t('importSkill.agent.extra')}
          >
            {props.agents!.length === 0 ? (
              <Alert type="warning">{t('importSkill.agent.noAgent')}</Alert>
            ) : (
              <Select
                size="full"
                value={selectedAgentId}
                onChange={setSelectedAgentId}
                placeholder={t('importSkill.agent.placeholder')}
                options={props.agents!.map((a) => ({ value: a.id, text: `${a.name}（${a.id}）` }))}
              />
            )}
          </Form.Item>
        </Form>
      )}

      {/* Mode tabs：只保留 directory（目录导入）/ session（对话导入）两种 */}
      <Segment
        className="_memory-isd-mode-segment"
        value={mode}
        onChange={(v) => setMode(v as Mode)}
        options={[
          { value: 'directory', text: t('importSkill.mode.directory') },
          { value: 'session', text: t('importSkill.mode.session') },
        ]}
      />

      {mode === 'directory' && (
        <div className="_memory-isd-section">
          <div className="_memory-isd-label">{t('importSkill.directory.label')}</div>
          {/*
            目录选择无 Tea 组件等价物，此处保留原生 input 作为唯一豁免，隐藏后由下方
            Tea Button 触发点击。webkitdirectory/directory 是非标准但广泛支持的浏览器
            属性，React 类型定义未收录，用 spread + any 透传而非逐属性 @ts-expect-error。
          */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={(e) => {
              const list = e.target.files;
              if (!list) return;
              setPickedFiles(Array.from(list));
            }}
            className="_memory-isd-hidden-file-input"
            {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          />
          <Button onClick={() => fileInputRef.current?.click()}>
            <FolderOpenIcon size={14} /> {t('importSkill.directory.selectFile')}
          </Button>
          {pickedFiles.length > 0 && (
            <span className="_memory-isd-picked-count">{t('importSkill.directory.picked', { count: pickedFiles.length })}</span>
          )}
          {pickedFiles.length > 0 && partition && (
            <div className="_memory-isd-partition-box">
              <div>
                {t('importSkill.directory.mainFile')}
                {partition.mainFile ? (
                  <span className="_memory-isd-main-file">
                    {partition.mainFile.webkitRelativePath || partition.mainFile.name}
                  </span>
                ) : (
                  <span className="_memory-isd-error-text">{t('importSkill.directory.noSkillMd')}</span>
                )}
              </div>
              <div>{t('importSkill.directory.resources', { count: partition.resources.length })}</div>
              {partition.resources.length > 0 && (
                <ul className="_memory-isd-resource-list">
                  {partition.resources.map((r) => (
                    <li key={r.path}>· {r.path} ({Math.round(r.file.size / 1024)}KB)</li>
                  ))}
                </ul>
              )}
              {partition.warning && (
                <div className="_memory-isd-warning-text">{partition.warning}</div>
              )}
            </div>
          )}
        </div>
      )}

      {mode === 'session' && (
        <div className="_memory-isd-section">
          <Alert type="info">
            {t('importSkill.session.hintPrefix')}
            <span className="_memory-isd-mono-inline">messages</span>
            {t('importSkill.session.hintSuffix')}
          </Alert>
          <Form layout="vertical" style={{ width: '100%' }}>
            <Form.Item label={t('importSkill.session.label')}>
              <Input.TextArea
                size="full"
                value={sessionPayload}
                onChange={setSessionPayload}
                rows={16}
                placeholder={JSON.stringify(
                  {
                    session_id: 'demo-user-extract-demo-1',
                    task_id: 'default',
                    messages: [
                      { role: 'user', content: t('importSkill.sample.user') },
                      { role: 'assistant', content: t('importSkill.sample.assistant') },
                      { role: 'tool_call', content: t('importSkill.sample.toolCall') },
                      { role: 'tool_result', content: t('importSkill.sample.toolResult') },
                      { role: 'assistant', content: t('importSkill.sample.assistant2') },
                    ],
                  },
                  null,
                  2,
                )}
                className="_memory-isd-mono-input"
              />
            </Form.Item>
          </Form>
        </div>
      )}

      {error && <Alert type="error">{error}</Alert>}
      {result && <Alert type="success"><span className="_memory-isd-result-text">{result}</span></Alert>}
      </Modal.Body>
      <Modal.Footer>
        <Button
          type="primary"
          onClick={() => void submit()}
          disabled={
            submitting
            || (mode === 'directory' ? !partition?.mainFile : !sessionPayload.trim())
            || (props.target === 'fixed' && !selectedAgentId)
          }
          title={props.target === 'fixed' && !selectedAgentId ? t('importSkill.error.noAgentHint') : ''}
          loading={submitting}
        >
          {mode === 'session' ? t('importSkill.session.submit') : t('importSkill.submit')}
        </Button>
        <Button onClick={props.onClose} disabled={submitting}>{t('importSkill.cancel')}</Button>
      </Modal.Footer>
    </Modal>
  );
}
