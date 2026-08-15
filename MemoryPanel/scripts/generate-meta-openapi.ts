/**
 * 生成新面板（stateless）链路 A OpenAPI 3.0。
 * 运行：pnpm generate:meta-openapi
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  META_ACTIONS,
  META_LIST_ACTIONS,
  isNotInScopeAction,
} from '../src/panel/api/meta-actions.js';

const OUT = join(process.cwd(), 'docs/api/meta-api.openapi.yaml');

const ACTION_TAG: Record<string, string> = {
  user: 'Meta · User',
  'user-key': 'Meta · User Key',
  team: 'Meta · Team',
  'team-member': 'Meta · Team Member',
  agent: 'Meta · Agent',
  task: 'Meta · Task',
  'task-agent': 'Meta · Task Agent',
  asset: 'Meta · Asset',
  'agent-fixed-asset': 'Meta · Agent Fixed Asset',
  acl: 'Meta · ACL',
  auth: 'Meta · Auth',
};

const AUTH_VERIFY = 'auth/verify';

function tagFor(action: string): string {
  const prefix = action.includes('/') ? action.slice(0, action.indexOf('/')) : action;
  if (action.startsWith('team-member')) return ACTION_TAG['team-member'] ?? 'Meta';
  if (action.startsWith('user-key')) return ACTION_TAG['user-key'] ?? 'Meta';
  if (action.startsWith('task-agent')) return ACTION_TAG['task-agent'] ?? 'Meta';
  if (action.startsWith('agent-fixed-asset')) return ACTION_TAG['agent-fixed-asset'] ?? 'Meta';
  return ACTION_TAG[prefix] ?? 'Meta';
}

function yamlQuote(s: string): string {
  if (/^[a-zA-Z0-9_./-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function panelDescription(action: string): string {
  if (isNotInScopeAction(action)) {
    return '新面板一期 **不转发** 至内核；Control 返回 HTTP 501、`message=NOT_IN_SCOPE`。';
  }
  if (action === AUTH_VERIFY) {
    return '登录验活：Header 仅 `X-Tdai-Service-Id`；body 须含 `user_key`。成功看 `data.valid`（软校验）。';
  }
  if (action === 'user/list') {
    return '透明代理；team_id 仅 system_admin 可省略（实例级 list）。可选 user_ids、username（精确匹配）过滤。响应 UserPublic 含 username。';
  }
  if (action === 'team-member/list') {
    return '分页 list；body 须 team_id。响应 items 为 TeamMemberEntity（含读时 JOIN 的 username，v3.2.2+）；仅 active 团队成员可调用。默认 joined_at DESC。须 Header 双凭证。';
  }
  if (action === 'team-member/get') {
    return '透明代理；响应 TeamMemberEntity 含 username（v3.2.2+，读时 JOIN）。须为 team active 成员。须 Header 双凭证。';
  }
  if (action === 'team-member/add') {
    return '透明代理；团队 admin。禁对自己 add、禁 demote owner。响应 TeamMemberEntity **不含** username（v3.2.2+）；添加后请 team-member/list 获取展示名。v3.2.3+：active 同 role 重复 add → 409 member_already_exists。';
  }
  if (action === 'team-member/remove') {
    return '透明代理；团队 admin。禁移除 team owner（403 cannot remove team owner）。物理删除成员行。须 Header 双凭证。';
  }
  if (action === 'team/update') {
    return '透明代理；team owner 或 admin。不可改 owner_user_id（传入静默忽略）。字段见 08-metadata-v3-api-reference.md。须 Header 双凭证。';
  }
  if (action === 'agent/update') {
    return '透明代理；agent owner。不可改 owner_user_id（传入静默忽略）。字段见 08-metadata-v3-api-reference.md。须 Header 双凭证。';
  }
  if (action === 'user/create' || action === 'user/delete') {
    return '透明代理；须 Header `X-Tdai-User-Key` 为 system_admin。非 admin → 内核 403。';
  }
  if (META_LIST_ACTIONS.has(action)) {
    return '分页 list；body 可选 limit（默认 20，最大 100）、offset（默认 0）。默认 created_at DESC（v3.1.2+；team-member 为 joined_at DESC）。须 Header 双凭证。';
  }
  return '透明代理至内核；字段见 08-metadata-v3-api-reference.md。须 Header 双凭证。';
}

function buildMetaPostPath(action: string): string {
  const lines: string[] = [];
  lines.push(`  /api/v1/meta/${action}:`);
  lines.push('    post:');
  lines.push(`      tags: [${yamlQuote(tagFor(action))}]`);
  lines.push(`      operationId: meta_${action.replace(/\//g, '_')}`);
  lines.push(`      summary: ${action}`);
  lines.push(`      description: ${yamlQuote(panelDescription(action))}`);
  lines.push('      security: []');
  lines.push('      parameters:');
  lines.push("        - $ref: '#/components/parameters/TdaiServiceId'");
  if (action !== AUTH_VERIFY) {
    lines.push("        - $ref: '#/components/parameters/TdaiUserKey'");
  }
  lines.push('      requestBody:');
  lines.push('        required: true');
  lines.push('        content:');
  lines.push('          application/json:');
  lines.push('            schema:');
  lines.push('              type: object');
  lines.push('              additionalProperties: true');
  lines.push('      responses:');
  lines.push("        '200':");
  lines.push('          description: 内核风格信封（业务成败优先看 body.code）');
  lines.push('          content:');
  lines.push('            application/json:');
  lines.push('              schema:');
  lines.push("                $ref: '#/components/schemas/ApiResponse'");
  if (isNotInScopeAction(action)) {
    lines.push("        '501':");
    lines.push('          $ref: "#/components/responses/NotInScope"');
  }
  lines.push("        '400':");
  lines.push('          $ref: "#/components/responses/ControlBadRequest"');
  lines.push("        '502':");
  lines.push('          $ref: "#/components/responses/KernelUnavailable"');
  lines.push("        '504':");
  lines.push('          $ref: "#/components/responses/KernelTimeout"');
  return lines.join('\n');
}

const header = `openapi: 3.0.3
info:
  title: Team Memory Control — 新面板元数据 API（stateless）
  description: |
    新面板 Control **无状态代理**：\`/api/v1/meta/*\` 透明转发记忆内核 \`/v3/meta/*\`（v3.1）。

    **鉴权（Header，无 cookie）**
    - \`X-Tdai-Service-Id\`：实例 ID（来自 \`GET /meta/instances\`，= 内核 \`x-tdai-service-id\`）
    - \`X-Tdai-User-Key\`：用户密钥 \`sk-mem-…\`（\`auth/verify\` 除外，user_key 仅放 body）

    **响应信封** \`{ code, message, request_id, data }\`
    - \`code === 0\` → HTTP **200**（请求执行成功）
    - \`code ∈ [400, 599]\` → HTTP 与 code **相等**
    - 软校验：\`auth/verify\` 看 \`data.valid\`；\`acl/check\` 看 \`data.allowed\`

    设计文档：[09-new-panel-control-backend-design.md](../architecture/09-new-panel-control-backend-design.md)
    内核字段权威：[08-metadata-v3-api-reference.md](../architecture/08-metadata-v3-api-reference.md)
  version: 1.3.1
  contact:
    name: team-memory-control

servers:
  - url: http://127.0.0.1:8123
    description: 本地 Control（\`PANEL_MODE=stateless\` 或 \`pnpm dev:panel\`）
  - url: https://{controlHost}
    description: 部署环境
    variables:
      controlHost:
        default: control.example.com

tags:
  - name: Meta · Control
    description: Control 辅助接口
  - name: Meta · User
  - name: Meta · User Key
  - name: Meta · Team
  - name: Meta · Team Member
  - name: Meta · Agent
  - name: Meta · Task
  - name: Meta · Task Agent
  - name: Meta · Asset
  - name: Meta · Agent Fixed Asset
  - name: Meta · ACL
  - name: Meta · Auth

paths:
  /api/v1/meta/instances:
    get:
      tags: [Meta · Control]
      operationId: meta_instances_list
      summary: 记忆实例列表（登录前）
      description: |
        返回配置文件中全部记忆实例，**无分页**。
        仅公开 \`instance_id\`、\`name\`（不含 gateway_endpoint / api_key）。
        配置：\`METADATA_INSTANCES_CONFIG\`（默认 \`./config/metadata-instances.json\`）。
      security: []
      responses:
        '200':
          description: 公开实例列表
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/MetadataInstanceListResponse'
              example:
                instances:
                  - instance_id: default
                    name: 社区研发演示实例
                  - instance_id: sre-platform
                    name: SRE 平台实例
`;

const metaPaths = META_ACTIONS.map(buildMetaPostPath).join('\n');

const components = `
components:
  parameters:
    TdaiServiceId:
      name: X-Tdai-Service-Id
      in: header
      required: true
      schema:
        type: string
      description: 记忆实例 ID（= 注册表 id = 内核 x-tdai-service-id）
      example: default
    TdaiUserKey:
      name: X-Tdai-User-Key
      in: header
      required: true
      schema:
        type: string
      description: 用户 API 密钥 sk-mem-…（auth/verify 不使用此 Header）
      example: sk-mem-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

  responses:
    ControlBadRequest:
      description: Control 校验错误（未转发内核）
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ApiResponse'
          example:
            code: 400
            message: INVALID_INSTANCE
            request_id: req-example
            data: null
    NotInScope:
      description: 未通过面板公开代理转发的 meta action
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ApiResponse'
          example:
            code: 501
            message: NOT_IN_SCOPE
            request_id: req-example
            data: null
    KernelUnavailable:
      description: 内核不可达
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ApiResponse'
          example:
            code: 502
            message: KERNEL_UNAVAILABLE
            request_id: req-example
            data: null
    KernelTimeout:
      description: 内核超时
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ApiResponse'
          example:
            code: 504
            message: KERNEL_TIMEOUT
            request_id: req-example
            data: null

  schemas:
    PublicMetadataInstance:
      type: object
      required: [instance_id, name]
      properties:
        instance_id:
          type: string
          description: 记忆实例 ID（对应内核 x-tdai-service-id）
          example: default
        name:
          type: string
          description: 登录页展示名称
          example: 社区研发演示实例

    MetadataInstanceListResponse:
      type: object
      required: [instances]
      properties:
        instances:
          type: array
          items:
            $ref: '#/components/schemas/PublicMetadataInstance'

    ApiResponse:
      type: object
      required: [code, message, request_id, data]
      properties:
        code:
          type: integer
          description: |
            0 = 请求执行成功。
            400–599 时 HTTP 状态码与 code 相等。
            判断业务成败优先看 code；软校验再看 data.valid / data.allowed。
          example: 0
        message:
          type: string
          example: ok
        request_id:
          type: string
          example: req-a1b2c3d4
        data:
          nullable: true
          description: 成功载荷；失败常为 null

    PaginatedResult:
      type: object
      required: [items, total, limit, offset]
      properties:
        items:
          type: array
          items:
            type: object
            additionalProperties: true
        total:
          type: integer
        limit:
          type: integer
          minimum: 1
          maximum: 100
        offset:
          type: integer
          minimum: 0

    PaginationInput:
      type: object
      properties:
        limit:
          type: integer
          minimum: 1
          maximum: 100
          default: 20
        offset:
          type: integer
          minimum: 0
          default: 0
`;

const yaml = [header, metaPaths, components].join('\n');
writeFileSync(OUT, yaml, 'utf8');
console.log(`Wrote ${OUT} (${META_ACTIONS.length} POST actions + GET instances)`);
