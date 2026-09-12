/**
 * `bridge-telemetry.ts` 的契约是每次上游请求完成都发一条 `bridge_call`,主路径照做:
 * 拿到响应发一条(含 4xx/5xx),upstream 不响应也发一条。files/download 分支只补了后者
 * ——那处 catch 的注释还写着"之前这个 catch 分支静默 return, 导致 curl 视角『打了 N 次』
 * CH 少一条",也就是说同一类洞已经为失败路径补过,成功路径被落下了。
 *
 * 下游是真有人读的:Core Analytics 用这些行算调用次数与会话调用率。成功下载缺行会把
 * 这些指标算低。
 *
 * 这些用例钉住"每条路径恰好一条",并且不改响应本身。
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

const emitted: Array<Record<string, unknown>> = [];
vi.mock("../../memory/bridge-telemetry.js", () => ({
  emitBridgeToolCallTelemetry: (row: Record<string, unknown>) => { emitted.push(row); },
  emitBridgeRejectTelemetry: (row: Record<string, unknown>) => { emitted.push({ ...row, _reject: true }); },
  agentSourceFromSessionKey: (k: string) => String(k).split(":")[0] || "claude-code",
}));

const { createSkillBridgeHandler } = await import("../skill-bridge.js");
const { getSessionStore } = await import("../../session/store.js");

const SESSION = "codebuddy:dl-test";
const config = {
  coreSkill: { endpoint: "http://core.invalid", serviceToken: "t", timeoutMs: 1000, serviceId: "sp-1" },
  skillRuntime: { allowLlmWrite: false },
} as never;

const ctx = (sub = "files/download") => {
  const req = new Request(`http://proxy/skill-bridge/v3/skill/${sub}`, {
    method: "POST",
    headers: { "x-conversation-id": "dl-test", "content-type": "application/json" },
    body: JSON.stringify({ skill_id: "skl-abc", path: "scripts/run.sh" }),
  });
  return { req: { url: req.url, method: "POST", raw: req,
                  header: (n: string) => req.headers.get(n) ?? undefined,
                  text: () => req.text(), json: () => req.json() } } as never;
};

const envelope = (data: unknown) => new Response(JSON.stringify({ code: 0, message: "ok", data }),
  { status: 200, headers: { "content-type": "application/json" } });

beforeEach(async () => {
  emitted.length = 0;
  await getSessionStore().set(SESSION, {
    status: "initialized",
    sessionInfo: { user_id: "usr-1", team_id: "team-1", agent_id: "agt-1", space_id: "sp-1" },
  } as never);
});

const calls = () => emitted.filter((r) => !r._reject);

describe("files/download emits exactly one bridge_call per upstream request", () => {
  test("成功下载:恰好一条,带真实状态码", async () => {
    const h = createSkillBridgeHandler(config, {
      fetcher: (async () => envelope({ content: "#!/bin/sh\necho hi\n", encoding: "utf-8", mime_type: "text/x-sh" })) as never,
      now: () => 1_000,
    });
    const res = await h(ctx());
    expect(res.status).toBe(200);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatchObject({ executedEndpoint: "files/download", upstreamStatus: 200, bridgeSource: "skill-bridge" });
  });

  test("上游 4xx:也恰好一条,记真实状态码", async () => {
    const h = createSkillBridgeHandler(config, {
      fetcher: (async () => new Response(JSON.stringify({ code: 40401, message: "not found" }),
        { status: 404, headers: { "content-type": "application/json" } })) as never,
    });
    await h(ctx());
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatchObject({ executedEndpoint: "files/download", upstreamStatus: 404 });
  });

  test("上游回了但内容不可用:仍是一条,不是零条也不是两条", async () => {
    const h = createSkillBridgeHandler(config, {
      fetcher: (async () => envelope({ encoding: "utf-8" })) as never,   // 没有 content
    });
    await h(ctx());
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatchObject({ upstreamStatus: 200 });
  });

  test("网络异常:原有的那一条还在,upstreamStatus=0", async () => {
    const h = createSkillBridgeHandler(config, {
      fetcher: (async () => { throw new Error("ECONNREFUSED"); }) as never,
    });
    await h(ctx());
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatchObject({ executedEndpoint: "files/download", upstreamStatus: 0 });
  });

  test("对照:同样成功的 files/read 本来就发一条 —— 缺的只是 download", async () => {
    // 这行数字在 PR 正文的对照表里,所以要测出来,不能靠读主路径代码推断。
    const h = createSkillBridgeHandler(config, {
      fetcher: (async () => envelope({ content: "x", encoding: "utf-8" })) as never,
    });
    await h(ctx("files/read"));
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatchObject({ executedEndpoint: "files/read", upstreamStatus: 200 });
  });

  test("响应本身不受埋点影响:成功时仍返回原始字节", async () => {
    const body = "#!/bin/sh\necho hi\n";
    const h = createSkillBridgeHandler(config, {
      fetcher: (async () => envelope({ content: body, encoding: "utf-8", mime_type: "text/x-sh" })) as never,
    });
    const res = await h(ctx());
    expect(await res.text()).toBe(body);
    expect(res.headers.get("content-type")).toBe("text/x-sh");
  });
});
