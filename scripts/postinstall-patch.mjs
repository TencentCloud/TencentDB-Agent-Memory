// postinstall 钩子：尝试运行 OpenClaw 的 after_tool_call patch。
//
// 此 patch 仅在 OpenClaw 场景下有意义——它修改 openclaw 安装目录下的
// dist 文件，为 context-offload 插件注入 ctx.params.session.messages。
// 在非 OpenClaw 场景（如 Claude Code MCP 适配器、Hermes）下无目标可 patch。
//
// 跨平台兼容：原 postinstall 直接调 `bash ... 2>/dev/null || true`，在
// Windows 上因 bash 缺失 + Unix shell 重定向语法导致 cmd.exe 解析失败、
// npm install 退出码 1。改用 node 包裹（node 跨平台且 engines 必装）。
//
// 失败条件（bash 不可用 / 未装 openclaw / 脚本非 0 退出）均视为软成功，
// 不阻塞 npm install。复刻原 `|| true` 的静默语义。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

try {
  const script = fileURLToPath(
    new URL("./openclaw-after-tool-call-messages.patch.sh", import.meta.url),
  );
  if (existsSync(script)) {
    spawnSync("bash", [script], { stdio: "ignore", shell: false });
  }
} catch {
  // 静默吞掉所有错误——postinstall 永不阻塞安装
}

process.exit(0);
