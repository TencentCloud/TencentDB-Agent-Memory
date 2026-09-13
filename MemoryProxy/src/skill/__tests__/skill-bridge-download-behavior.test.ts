/**
 * 下载分支的两件事。
 *
 * ① 合法的空文件被当成异常。判断是 `if (parsed.code !== 0 || !parsed.data?.content)`,
 *    而 `""` 是 falsy —— 于是一个真实存在、内容为空的资源,返回的不是 0 字节文件,
 *    而是整个 JSON 信封。Core 侧两种编码都接受零字节资源。
 *
 * ② 注入给模型的说明说:对 `files/read` 的 curl 加 `-o` 就能拿到原始字节。
 *    服务端看不见 `-o`(那是 curl 客户端参数),它按**子路径**分流;真正返回字节的是
 *    独立的 `files/download`,而说明里从没提过这条路。
 *
 * 这些用例把两件事都钉住,并保留原有的错误透传行为。
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

vi.mock("../../memory/bridge-telemetry.js", () => ({
  emitBridgeToolCallTelemetry: () => {},
  emitBridgeRejectTelemetry: () => {},
  agentSourceFromSessionKey: (k: string) => String(k).split(":")[0] || "claude-code",
}));

const { createSkillBridgeHandler } = await import("../skill-bridge.js");
const { getSessionStore } = await import("../../session/store.js");
const { renderSkillToolsBlock } = await import("../../injection/injectors/skill-tools-injector.js");

const SESSION = "codebuddy:dl-behavior";
const config = {
  coreSkill: { endpoint: "http://core.invalid", serviceToken: "t", timeoutMs: 1000, serviceId: "sp-1" },
  skillRuntime: { allowLlmWrite: false },
} as never;

const ctx = (sub: string) => {
  const req = new Request(`http://proxy/skill-bridge/v3/skill/${sub}`, {
    method: "POST",
    headers: { "x-conversation-id": "dl-behavior", "content-type": "application/json" },
    body: JSON.stringify({ skill_id: "skl-abc", path: "scripts/empty.sh" }),
  });
  return { req: { url: req.url, method: "POST", raw: req,
                  header: (n: string) => req.headers.get(n) ?? undefined,
                  text: () => req.text(), json: () => req.json() } } as never;
};

const core = (data: unknown, code = 0) => new Response(JSON.stringify({ code, message: "ok", data }),
  { status: 200, headers: { "content-type": "application/json" } });

const run = async (data: unknown, sub = "files/download") => {
  const h = createSkillBridgeHandler(config, { fetcher: (async () => core(data)) as never });
  const res = await h(ctx(sub));
  const body = await res.arrayBuffer();
  return { res, bytes: body.byteLength, text: new TextDecoder().decode(body) };
};

beforeEach(async () => {
  await getSessionStore().set(SESSION, {
    status: "initialized",
    sessionInfo: { user_id: "usr-1", team_id: "team-1", agent_id: "agt-1", space_id: "sp-1" },
  } as never);
});

describe("① 合法的空文件下载后应当是空文件", () => {
  test("utf-8 的零字节资源:返回 0 字节,不是 JSON 信封", async () => {
    const { res, bytes, text } = await run({ content: "", encoding: "utf-8", mime_type: "text/x-sh", size_bytes: 0 });
    expect(res.status).toBe(200);
    expect(text).not.toMatch(/"code"/);          // 不是信封
    expect(bytes).toBe(0);
    expect(res.headers.get("content-type")).toBe("text/x-sh");
  });

  test("base64 的零字节资源:同样是 0 字节", async () => {
    const { bytes, text } = await run({ content: "", encoding: "base64", mime_type: "application/octet-stream" });
    expect(text).not.toMatch(/"code"/);
    expect(bytes).toBe(0);
  });

  test("content 字段缺失:仍按原样透传信封(这才是真的异常)", async () => {
    const { text } = await run({ encoding: "utf-8" });
    expect(text).toMatch(/"code"/);
  });

  test("content 类型不对:也按原样透传信封", async () => {
    const { text } = await run({ content: 123, encoding: "utf-8" });
    expect(text).toMatch(/"code"/);
  });

  test("非空文件不受影响", async () => {
    const body = "#!/bin/sh\necho hi\n";
    const { bytes, text } = await run({ content: body, encoding: "utf-8", mime_type: "text/x-sh" });
    expect(text).toBe(body);
    expect(bytes).toBe(Buffer.byteLength(body));
  });

  test("对照:同一个空资源走 files/read,拿到的是信封(这条路本来就该返回 JSON)", async () => {
    const { text } = await run({ content: "", encoding: "utf-8" }, "files/read");
    expect(text).toMatch(/"code"/);
  });
});

describe("② 注入给模型的下载配方要指向真正返回字节的那条路", () => {
  const block = () => renderSkillToolsBlock("http://proxy", false);

  test("说明里出现 files/download", () => {
    expect(block()).toMatch(/files\/download/);
  });

  test("不再声称给 files/read 加 -o 就会拿到原始字节", () => {
    const s = block();
    const readRecipe = s.slice(s.indexOf("skill_files_read"), s.indexOf("skill_files_read") + 900);
    expect(readRecipe).not.toMatch(/加 -o[^\n]*原始字节|proxy 会返回原始字节/);
  });

  test("读与下载是两个配方,各自写明返回什么", () => {
    const s = block();
    expect(s).toMatch(/files\/read/);
    expect(s).toMatch(/JSON 信封/);
    expect(s).toMatch(/原始字节|raw bytes/);
  });
});
