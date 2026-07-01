/**
 * Dify 工具提供器适配器。
 *
 * Dify 是一个 AI 工作流平台。此适配器生成 OpenAPI 3.0 规范文档，
 * 用户可在 Dify 中导入此文档作为自定义工具。
 *
 * 这是唯一覆盖 Dify 平台的 PR。
 */

import { BaseMemoryPlatformAdapter } from "../memory-platform-adapter.js";
import type { GatewayClient } from "../shared/gateway-client.js";

/**
 * Dify 平台适配器。
 */
export class DifyMemoryAdapter extends BaseMemoryPlatformAdapter {
  readonly name = "dify-adapter";
  readonly platform = "dify";

  constructor(client: GatewayClient) {
    super(client);
  }
}
