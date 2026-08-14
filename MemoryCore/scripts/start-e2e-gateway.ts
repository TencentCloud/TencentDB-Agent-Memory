/**
 * 为 SDK 真机 e2e 启动一个临时 gateway。
 *
 * 用独立端口 + 临时数据目录，不碰开发机上已在运行的服务。
 * 启动后打印 admin user_key，供 e2e 脚本使用；Ctrl-C / SIGTERM 退出时清理数据目录。
 *
 * 用法：
 *   node --import tsx scripts/start-e2e-gateway.ts [port]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import { TdaiGateway } from "../src/gateway/server.js";

const PORT = Number(process.argv[2] ?? 18620);
const API_KEY = process.env.E2E_API_KEY ?? "sdk-e2e-token";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-e2e-gw-"));

process.env.TDAI_METADATA_SQLITE_BASE_DIR = path.join(tmpDir, "metadata");

function post(pathname: string, body: unknown): Promise<{ status: number; body: any }> {
  const json = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      new URL(pathname, `http://127.0.0.1:${PORT}`),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(json)),
          "x-tdai-service-id": "default",
          Authorization: `Bearer ${API_KEY}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: raw }); }
        });
      },
    );
    req.on("error", reject);
    req.write(json);
    req.end();
  });
}

const gateway = new TdaiGateway({
  server: { port: PORT, host: "127.0.0.1", apiKey: API_KEY },
  data: { baseDir: tmpDir },
  // 占位 LLM：本次只验证删除链路，不需要真实蒸馏
  llm: { baseUrl: "http://localhost:1", apiKey: "test-key", model: "test-model" },
});

async function shutdown() {
  try { await gateway.stop(); } catch { /* ignore */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await gateway.start();

// 初始化 admin，输出 user_key 给 e2e 脚本
const admin = await post("/v3/internal/meta/user/init-admin", {
  username: `sdk-e2e-admin-${Date.now().toString(36)}`,
});
const adminKey = admin.body?.data?.user_key ?? admin.body?.data?.default_user_key;

console.log("GATEWAY_READY");
console.log(`PORT=${PORT}`);
console.log(`ADMIN_KEY=${adminKey}`);
console.log(`DATA_DIR=${tmpDir}`);

// 保持进程存活：gateway 的 HTTP server 未必能单独撑住事件循环
// （尤其在 setsid/nohup 脱离终端后），显式挂一个 timer 直到收到信号。
setInterval(() => { /* keep-alive */ }, 1 << 30);
