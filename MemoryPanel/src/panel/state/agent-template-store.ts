/**
 * 默认 Agent 模板的本地文件存储（存 Panel 本地）。
 *
 * 路径：{dir}/{instanceId}/{team_id}/template.json
 * - 写入覆盖式 upsert（JSON 2 空格缩进）；
 * - 读取 ENOENT 返回 null（无模板）。
 * - team_id 做路径穿越防御。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface AgentTemplateAssetIds {
  skills?: string[];
  code_graphs?: string[];
  wikis?: string[];
}

/** 模板配置（= JSON 文件内容，对齐 agent/create 入参）。 */
export interface AgentTemplateConfig {
  name: string;
  description?: string | null;
  prompt?: string | null;
  visibility?: string;
  metadata_json?: string;
  asset_ids?: AgentTemplateAssetIds;
}

function templateFilePath(dir: string, instanceId: string, teamId: string): string {
  if (/[/\\]|\.\./.test(teamId)) {
    throw new Error(`invalid team_id for template path: ${teamId}`);
  }
  return path.join(dir, instanceId, teamId, 'template.json');
}

export function saveAgentTemplate(
  dir: string,
  instanceId: string,
  teamId: string,
  config: AgentTemplateConfig,
): void {
  const filePath = templateFilePath(dir, instanceId, teamId);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
}

export function getAgentTemplate(
  dir: string,
  instanceId: string,
  teamId: string,
): AgentTemplateConfig | null {
  const filePath = templateFilePath(dir, instanceId, teamId);
  try {
    const raw = readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as AgentTemplateConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
}
