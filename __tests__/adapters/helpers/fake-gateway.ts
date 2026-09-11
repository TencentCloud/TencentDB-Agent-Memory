/**
 * Fake Gateway — 轻量级 fake HTTP server，模拟 TDAI Gateway 行为。
 *
 * 使适配器测试无需启动真实 Gateway 进程。参考 PR #540 的 fake_gateway.py 设计。
 *
 * 特性：
 * - 可编程的端点响应（每个端点可独立设置）
 * - 延迟模拟（测试超时/重试）
 * - 错误注入（返回特定 HTTP 状态码）
 * - 请求追踪（断言适配器发出了正确的请求）
 * - 基于 `node:http`，零外部依赖
 *
 * @example
 * ```ts
 * const gw = new FakeGateway();
 * await gw.start();
 *
 * // 设置召回响应
 * gw.onRecall({ context: "测试记忆", strategy: "bm25", memory_count: 2 });
 *
 * const client = new HttpMemoryClient({ baseUrl: gw.url });
 * const result = await client.recall({ query: "测试", sessionKey: "s1" });
 * expect(result.context).toBe("测试记忆");
 *
 * // 验证请求
 * const lastReq = gw.lastRecallRequest();
 * expect(lastReq?.query).toBe("测试");
 *
 * await gw.stop();
 * ```
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

// ============================
// 可编程响应
// ============================

interface StoredCapture {
  user_content: string;
  assistant_content: string;
  session_key: string;
  session_id?: string;
  user_id?: string;
}

interface StoredRecall {
  query: string;
  session_key: string;
  user_id?: string;
}

/**
 * Fake HTTP Gateway 服务器。
 *
 * 监听随机端口，模拟 Gateway REST API 的所有端点。
 * 每个端点可独立设置响应内容和行为。
 */
export class FakeGateway {
  private server: http.Server | null = null;
  private _port = 0;
  private _baseUrl = "";

  // 端点配置
  private _healthResponse: object = {
    status: "ok",
    version: "fake-gateway-1.0",
    uptime: 3600,
    stores: { vectorStore: true, embeddingService: true },
  };
  private _healthStatus = 200;

  private _recallResponse: object = {
    context: "fake recall context",
    strategy: "bm25",
    memory_count: 5,
  };
  private _recallStatus = 200;
  private _recallDelayMs = 0;

  private _captureResponse: object = {
    l0_recorded: 1,
    scheduler_notified: true,
  };
  private _captureStatus = 200;

  private _searchMemoriesResponse: object = {
    results: JSON.stringify([{ content: "fake L1", score: 0.9 }]),
    total: 1,
    strategy: "hybrid",
  };
  private _searchMemoriesStatus = 200;

  private _searchConversationsResponse: object = {
    results: JSON.stringify([{ role: "user", content: "fake L0" }]),
    total: 1,
  };
  private _searchConversationsStatus = 200;

  private _sessionEndResponse: object = {
    flushed: true,
  };
  private _sessionEndStatus = 200;

  // 请求追踪
  private _recalls: StoredRecall[] = [];
  private _captures: StoredCapture[] = [];
  private _searchMemoriesQueries: Array<{ query: string; limit?: number }> = [];
  private _searchConversationsQueries: Array<{ query: string; session_key?: string }> = [];
  private _sessionEndKeys: Array<{ session_key: string }> = [];
  private _healthChecks = 0;

  // 自定义处理器（覆盖默认端点行为）
  private _customHandler: ((req: http.IncomingMessage, body: unknown) => { status: number; body: object } | null) | null = null;

  // ============================
  // 生命周期
  // ============================

  get url(): string {
    return this._baseUrl;
  }

  get port(): number {
    return this._port;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    return new Promise((resolve) => {
      this.server!.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address() as AddressInfo;
        this._port = addr.port;
        this._baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // ============================
  // 端点配置方法
  // ============================

  /** 设置 /health 端点的自定义响应。 */
  onHealth(response: object, status = 200): void {
    this._healthResponse = response;
    this._healthStatus = status;
  }

  /** 设置 /recall 端点的自定义响应。 */
  onRecall(response: object, status = 200, delayMs = 0): void {
    this._recallResponse = response;
    this._recallStatus = status;
    this._recallDelayMs = delayMs;
  }

  /** 设置 /capture 端点的自定义响应。 */
  onCapture(response: object, status = 200): void {
    this._captureResponse = response;
    this._captureStatus = status;
  }

  /** 设置 /search/memories 端点的自定义响应。 */
  onSearchMemories(response: object, status = 200): void {
    this._searchMemoriesResponse = response;
    this._searchMemoriesStatus = status;
  }

  /** 设置 /search/conversations 端点的自定义响应。 */
  onSearchConversations(response: object, status = 200): void {
    this._searchConversationsResponse = response;
    this._searchConversationsStatus = status;
  }

  /** 设置 /session/end 端点的自定义响应。 */
  onSessionEnd(response: object, status = 200): void {
    this._sessionEndResponse = response;
    this._sessionEndStatus = status;
  }

  /** 注入自定义处理器，覆盖所有默认端点行为。 */
  setCustomHandler(
    handler: (req: http.IncomingMessage, body: unknown) => { status: number; body: object } | null,
  ): void {
    this._customHandler = handler;
  }

  // ============================
  // 请求追踪读取方法
  // ============================

  lastRecallRequest(): StoredRecall | undefined {
    return this._recalls[this._recalls.length - 1];
  }

  allRecallRequests(): StoredRecall[] {
    return [...this._recalls];
  }

  lastCaptureRequest(): StoredCapture | undefined {
    return this._captures[this._captures.length - 1];
  }

  allCaptureRequests(): StoredCapture[] {
    return [...this._captures];
  }

  recallCount(): number {
    return this._recalls.length;
  }

  captureCount(): number {
    return this._captures.length;
  }

  healthChecks(): number {
    return this._healthChecks;
  }

  /** 清除所有请求追踪数据。 */
  reset(): void {
    this._recalls = [];
    this._captures = [];
    this._searchMemoriesQueries = [];
    this._searchConversationsQueries = [];
    this._sessionEndKeys = [];
    this._healthChecks = 0;
    // 重置所有响应到默认值
    this._healthStatus = 200;
    this._recallStatus = 200;
    this._captureStatus = 200;
    this._searchMemoriesStatus = 200;
    this._searchConversationsStatus = 200;
    this._sessionEndStatus = 200;
    this._recallDelayMs = 0;
    this._customHandler = null;
  }

  // ============================
  // 内部
  // ============================

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // 解析 body
    const body = await this.readBody(req);

    // 自定义处理器优先
    if (this._customHandler) {
      const custom = this._customHandler(req, body);
      if (custom) {
        this.sendJson(res, custom.status, custom.body);
        return;
      }
    }

    const url = req.url ?? "/";
    const method = (req.method ?? "GET").toUpperCase();

    // 路由分发
    try {
      if (url === "/health" && method === "GET") {
        this._healthChecks++;
        this.sendJson(res, this._healthStatus, this._healthResponse);
      } else if (url === "/recall" && method === "POST") {
        const b = body as StoredRecall;
        this._recalls.push(b);
        if (this._recallDelayMs > 0) {
          await new Promise((r) => setTimeout(r, this._recallDelayMs));
        }
        this.sendJson(res, this._recallStatus, this._recallResponse);
      } else if (url === "/capture" && method === "POST") {
        const b = body as StoredCapture;
        this._captures.push(b);
        this.sendJson(res, this._captureStatus, this._captureResponse);
      } else if (url === "/search/memories" && method === "POST") {
        const b = body as { query: string; limit?: number };
        this._searchMemoriesQueries.push(b);
        this.sendJson(res, this._searchMemoriesStatus, this._searchMemoriesResponse);
      } else if (url === "/search/conversations" && method === "POST") {
        const b = body as { query: string; session_key?: string };
        this._searchConversationsQueries.push(b);
        this.sendJson(res, this._searchConversationsStatus, this._searchConversationsResponse);
      } else if (url === "/session/end" && method === "POST") {
        const b = body as { session_key: string };
        this._sessionEndKeys.push(b);
        this.sendJson(res, this._sessionEndStatus, this._sessionEndResponse);
      } else {
        this.sendJson(res, 404, { error: `Not found: ${method} ${url}` });
      }
    } catch (err) {
      this.sendJson(res, 500, { error: String(err) });
    }
  }

  private readBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      req.on("end", () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          resolve({ raw: data });
        }
      });
    });
  }

  private sendJson(res: http.ServerResponse, status: number, body: object): void {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(json),
    });
    res.end(json);
  }
}
