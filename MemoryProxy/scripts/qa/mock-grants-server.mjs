// grant 控制面演示端点：验证 Proxy 的 grants-fetcher（TTL 拉取）闭环。
// 用法：node tools-2026/mock-grants-server.mjs [port=8180]
// 然后 .env 配 tdai.grantsEndpoint=http://127.0.0.1:8180/grants，重启 proxy，
// 观察日志 grants.refreshed（每 60s 拉一次，或首拉立即）。
import http from "node:http";

const port = Number(process.argv[2] || 8180);
const grants = [
  { teamId: process.env.TDAI_TEST_TEAM_ID || "team-xxxxxxxx", agentId: process.env.TDAI_TEST_AGENT_ID || "agt-xxxxxxxx" },
  { teamId: "team-grant-b", agentId: "agt-grant-01" },
];

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(grants));
  })
  .listen(port, () => {
    console.log(`[mock-grants] listening on http://127.0.0.1:${port}/grants`);
    console.log(`  grants: ${JSON.stringify(grants)}`);
  });
