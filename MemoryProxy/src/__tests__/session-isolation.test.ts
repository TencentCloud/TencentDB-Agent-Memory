/**
 * 会话隔离与容量控制的用例：scope 维度隔离、LRU 淘汰、决策计数。
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  resolveOrCreateSessionId,
  pruneExpiredSessions,
  recentExpiredSessions,
  __setAutoSessionNow,
  __resetAutoSessionForTests,
} from "../session/auto-session.js";
import {
  resolveEffectiveConversationId,
  firstUserMessageFingerprint,
} from "../session/session-key.js";
import { validateAutoConversationConfig } from "../config.js";
import {
  getSessionStats,
  getSessionStatsBreakdown,
  resetSessionStats,
  recordSession,
  sessionStatsToPrometheus,
} from "../common/session-stats.js";

describe("会话隔离（scope 维度）", () => {
  beforeEach(() => {
    __resetAutoSessionForTests();
    resetSessionStats();
    __setAutoSessionNow(() => 1_000_000);
  });
  afterAll(() => {
    __resetAutoSessionForTests();
    resetSessionStats();
    __setAutoSessionNow(() => Date.now());
  });

  it("per-key-msg：同 key 同指纹，不同 scope 各自独立会话", () => {
    const cfg = { enabled: true, ttlMinutes: 30, strategy: "per-key-msg" } as const;
    const a1 = resolveOrCreateSessionId(null, "k", cfg, "fp-a", "thread-1");
    const a2 = resolveOrCreateSessionId(null, "k", cfg, "fp-a", "thread-2");
    expect(a2.sessionId).not.toBe(a1.sessionId);
    // 同 scope 续接同一会话
    const a3 = resolveOrCreateSessionId(null, "k", cfg, "fp-a", "thread-1");
    expect(a3.sessionId).toBe(a1.sessionId);
    expect(a3.reused).toBe(true);
  });

  it("per-key：默认一 key 一会话；带 scope 时按 (key, scope) 隔离", () => {
    const cfg = { enabled: true, ttlMinutes: 30 } as const;
    const p1 = resolveOrCreateSessionId(null, "k", cfg);
    const p2 = resolveOrCreateSessionId(null, "k", cfg);
    expect(p2.sessionId).toBe(p1.sessionId); // 无 scope，维持原行为

    const s1 = resolveOrCreateSessionId(null, "k", cfg, undefined, "thread-1");
    const s2 = resolveOrCreateSessionId(null, "k", cfg, undefined, "thread-2");
    expect(s1.sessionId).not.toBe(s2.sessionId);
    const s3 = resolveOrCreateSessionId(null, "k", cfg, undefined, "thread-1");
    expect(s3.sessionId).toBe(s1.sessionId);
  });
});

describe("容量控制（LRU 淘汰）", () => {
  beforeEach(() => {
    __resetAutoSessionForTests();
    resetSessionStats();
    __setAutoSessionNow(() => 1_000_000);
  });
  afterAll(() => {
    __resetAutoSessionForTests();
    resetSessionStats();
    __setAutoSessionNow(() => Date.now());
  });

  it("超过上限后淘汰最久未用的会话，保留最近活跃的", () => {
    const cfg = { enabled: true, ttlMinutes: 30 } as const;
    // 2000 个 key，每个 lastSeen 依次递增 1 秒，保证淘汰顺序确定
    let firstSid = "";
    for (let i = 0; i < 2000; i++) {
      __setAutoSessionNow(() => 1_000_000 + i * 1000);
      const r = resolveOrCreateSessionId(null, `k-${i}`, cfg);
      if (i === 0) firstSid = r.sessionId;
    }
    // 再插入 100 个，越过上限（2048），触发淘汰到 80% 下限
    __setAutoSessionNow(() => 1_000_000 + 10 * 60_000);
    let lastSid = "";
    for (let i = 2000; i < 2100; i++) {
      const r = resolveOrCreateSessionId(null, `k-${i}`, cfg);
      if (i === 2099) lastSid = r.sessionId;
    }
    const oldest = resolveOrCreateSessionId(null, "k-0", cfg);
    const newest = resolveOrCreateSessionId(null, "k-2099", cfg);
    // 最旧的被淘汰 → 重新生成新会话；最新的仍在 → 续接
    expect(oldest.sessionId).not.toBe(firstSid);
    expect(newest.sessionId).toBe(lastSid);
    expect(getSessionStats().capEvicted).toBeGreaterThan(0);
  });
});

describe("会话决策计数", () => {
  beforeEach(() => {
    __resetAutoSessionForTests();
    resetSessionStats();
    __setAutoSessionNow(() => 1_000_000);
  });
  afterAll(() => {
    __resetAutoSessionForTests();
    resetSessionStats();
    __setAutoSessionNow(() => Date.now());
  });

  it("created / resumed / expired 计数正确", () => {
    const cfg = { enabled: true, ttlMinutes: 30 } as const;
    resolveOrCreateSessionId(null, "k", cfg);
    resolveOrCreateSessionId(null, "k", cfg); // 续接
    __setAutoSessionNow(() => 1_000_000 + 31 * 60_000);
    resolveOrCreateSessionId(null, "k", cfg); // 过期后新建
    const s = getSessionStats();
    expect(s.created).toBe(2);
    expect(s.resumed).toBe(1);
    expect(s.expired).toBe(1);
  });

  it("per-key-msg 窗口超限时计数 windowEvicted", () => {
    const cfg = { enabled: true, ttlMinutes: 30, strategy: "per-key-msg" } as const;
    for (let i = 0; i < 9; i++) {
      resolveOrCreateSessionId(null, "k", cfg, `fp-${i}`);
    }
    expect(getSessionStats().created).toBe(9);
    expect(getSessionStats().windowEvicted).toBe(1);
  });
});

describe("HMAC 会话 ID（防幽灵/防伪造）", () => {
  beforeEach(() => {
    __resetAutoSessionForTests();
    resetSessionStats();
    __setAutoSessionNow(() => 1_000_000);
  });
  afterAll(() => {
    __resetAutoSessionForTests();
    resetSessionStats();
    __setAutoSessionNow(() => Date.now());
  });

  it("合法 ID 续接；篡改或换 key 后拒绝并重新生成", () => {
    const cfg = { enabled: true, ttlMinutes: 30 } as const;
    const first = resolveOrCreateSessionId(null, "k", cfg);
    const ok = resolveOrCreateSessionId(first.sessionId, "k", cfg);
    expect(ok.sessionId).toBe(first.sessionId);
    expect(ok.autoGenerated).toBe(false);

    const tampered =
      first.sessionId.slice(0, -1) +
      (first.sessionId.endsWith("a") ? "b" : "a");
    const g1 = resolveOrCreateSessionId(tampered, "k", cfg);
    expect(g1.sessionId).not.toBe(tampered);
    expect(g1.autoGenerated).toBe(true);
    expect(getSessionStats().ghostRejected).toBeGreaterThan(0);

    resetSessionStats();
    const g2 = resolveOrCreateSessionId(first.sessionId, "other-key", cfg);
    expect(g2.sessionId).not.toBe(first.sessionId);
    expect(getSessionStats().ghostRejected).toBe(1);
  });
});

describe("全局窗口上限与定期清理", () => {
  beforeEach(() => {
    __resetAutoSessionForTests();
    resetSessionStats();
    __setAutoSessionNow(() => 1_000_000);
  });
  afterAll(() => {
    __resetAutoSessionForTests();
    resetSessionStats();
    __setAutoSessionNow(() => Date.now());
  });

  it("窗口总量超限后淘汰最旧并计数", () => {
    const cfg = { enabled: true, ttlMinutes: 30, strategy: "per-key-msg" } as const;
    let firstSid = "";
    for (let k = 0; k < 600; k++) {
      for (let w = 0; w < 8; w++) {
        const r = resolveOrCreateSessionId(null, `k-${k}`, cfg, `fp-${k}-${w}`);
        if (k === 0 && w === 0) firstSid = r.sessionId;
      }
    }
    expect(getSessionStats().capEvicted).toBeGreaterThan(0);
    // 最早的窗口（k-0/fp-0-0）应已被淘汰 → 重新生成新会话
    const again = resolveOrCreateSessionId(null, "k-0", cfg, "fp-0-0");
    expect(again.sessionId).not.toBe(firstSid);
  });

  it("pruneExpiredSessions 清理过期会话并计入 expired", () => {
    const cfg = { enabled: true, ttlMinutes: 30, strategy: "per-key-msg" } as const;
    resolveOrCreateSessionId(null, "k-old", cfg, "fp-a");
    __setAutoSessionNow(() => 1_000_000 + 31 * 60_000);
    resolveOrCreateSessionId(null, "k-new", cfg, "fp-b");
    const before = getSessionStats().expired;
    const removed = pruneExpiredSessions(30);
    expect(removed).toBeGreaterThan(0);
    expect(getSessionStats().expired).toBeGreaterThan(before);
  });
});

describe("scope 接线与配置校验", () => {
  beforeEach(() => {
    __resetAutoSessionForTests();
    resetSessionStats();
    __setAutoSessionNow(() => 1_000_000);
  });
  afterAll(() => {
    __resetAutoSessionForTests();
    resetSessionStats();
    __setAutoSessionNow(() => Date.now());
  });

  it("resolveEffectiveConversationId 把 x-thread-id 接成 scope", () => {
    const config = {
      sessionInit: { autoConversationId: { enabled: true, ttlMinutes: 30, strategy: "per-key" } },
    } as never;
    const mkCtx = (headers: Record<string, string>) =>
      ({ req: { header: (n: string) => headers[n] ?? null } }) as never;
    const a = resolveEffectiveConversationId(mkCtx({ "x-thread-id": "t1" }), "k", config);
    const b = resolveEffectiveConversationId(mkCtx({ "x-thread-id": "t2" }), "k", config);
    expect(a.conversationId).not.toBe(b.conversationId);
    const a2 = resolveEffectiveConversationId(mkCtx({ "x-thread-id": "t1" }), "k", config);
    expect(a2.conversationId).toBe(a.conversationId);
  });

  it("配置校验：非法 ttlMinutes / strategy 抛错", () => {
    expect(() => validateAutoConversationConfig({ ttlMinutes: 0 })).toThrow();
    expect(() => validateAutoConversationConfig({ ttlMinutes: -1 })).toThrow();
    expect(() => validateAutoConversationConfig({ strategy: "nope" })).toThrow();
    expect(() => validateAutoConversationConfig({ maxEntries: 0 })).toThrow();
    expect(() => validateAutoConversationConfig({ maxWindowsTotal: -5 })).toThrow();
    expect(() =>
      validateAutoConversationConfig({
        ttlMinutes: 30,
        strategy: "per-key",
        maxEntries: 2048,
        maxWindowsPerKey: 8,
        maxWindowsTotal: 4096,
      }),
    ).not.toThrow();
  });

  it("容量参数可配置：maxWindowsPerKey 生效", () => {
    const cfg = {
      enabled: true,
      ttlMinutes: 30,
      strategy: "per-key-msg",
      maxWindowsPerKey: 2,
    } as const;
    resolveOrCreateSessionId(null, "k", cfg, "fp-0");
    resolveOrCreateSessionId(null, "k", cfg, "fp-1");
    resolveOrCreateSessionId(null, "k", cfg, "fp-2"); // 超 2 → 淘汰最旧
    expect(getSessionStats().windowEvicted).toBe(1);
    const again = resolveOrCreateSessionId(null, "k", cfg, "fp-0");
    const fp2 = resolveOrCreateSessionId(null, "k", cfg, "fp-2");
    expect(again.sessionId).not.toBe(fp2.sessionId); // fp-0 被挤出，fp-2 保留
  });

  it("首条 user 消息为空或纯图片时指纹回退为 undefined", () => {
    expect(firstUserMessageFingerprint([{ role: "user", content: "" }])).toBeUndefined();
    expect(firstUserMessageFingerprint([{ role: "user", content: "  " }])).toBeUndefined();
    expect(
      firstUserMessageFingerprint([
        { role: "user", content: [{ type: "image_url", image_url: { url: "http://x" } }] },
      ]),
    ).toBeUndefined();
  });
});

describe("确定性会话 ID（deterministic）", () => {
  beforeEach(() => {
    __resetAutoSessionForTests();
    resetSessionStats();
    __setAutoSessionNow(() => 1_000_000);
  });
  afterAll(() => {
    __resetAutoSessionForTests();
    resetSessionStats();
    __setAutoSessionNow(() => Date.now());
  });

  it("同 (key, scope, fp, epoch)：Map 清空（模拟重启/另一实例）后仍收敛到同一 sid", () => {
    const cfg = { enabled: true, ttlMinutes: 30, deterministic: true } as const;
    const a = resolveOrCreateSessionId(null, "k", cfg, "fp-a", "th-1");
    expect(a.sessionId).toMatch(/^auto-[0-9a-f]{16}-/);
    __resetAutoSessionForTests(); // 模拟进程重启 / 冷 pod
    const b = resolveOrCreateSessionId(null, "k", cfg, "fp-a", "th-1");
    expect(b.sessionId).toBe(a.sessionId);
  });

  it("epoch 滚动（空闲跨 TTL）后派生不同 sid，隔离旧会话", () => {
    const cfg = { enabled: true, ttlMinutes: 30, deterministic: true } as const;
    const a = resolveOrCreateSessionId(null, "k", cfg, "fp-a", "th-1");
    __setAutoSessionNow(() => 1_000_000 + 30 * 60_000 + 1); // 下一个 epoch
    __resetAutoSessionForTests(); // 空闲导致 Map 过期丢失
    const b = resolveOrCreateSessionId(null, "k", cfg, "fp-a", "th-1");
    expect(b.sessionId).not.toBe(a.sessionId);
  });

  it("非 deterministic（默认）仍走随机 uuid，重启不收敛", () => {
    const cfg = { enabled: true, ttlMinutes: 30 } as const;
    const a = resolveOrCreateSessionId(null, "k", cfg, "fp-a", "th-1");
    __resetAutoSessionForTests();
    const b = resolveOrCreateSessionId(null, "k", cfg, "fp-a", "th-1");
    expect(b.sessionId).not.toBe(a.sessionId);
  });

  it("钉住 deterministicBucketMinutes 后，只调 ttl 不触发全量轮换", () => {
    const cfgA = {
      enabled: true,
      ttlMinutes: 30,
      deterministic: true,
      deterministicBucketMinutes: 120,
    } as const;
    const a = resolveOrCreateSessionId(null, "k", cfgA, "fp-a", "th-1");
    __setAutoSessionNow(() => 1_000_000 + 31 * 60_000); // 超过原 ttl，仍在 120min 桶内
    __resetAutoSessionForTests(); // 模拟重启
    const cfgB = { ...cfgA, ttlMinutes: 45 } as const; // ttl 变更但桶宽钉住
    const b = resolveOrCreateSessionId(null, "k", cfgB, "fp-a", "th-1");
    expect(b.sessionId).toBe(a.sessionId);
  });
});

describe("SID scope/指纹绑定（防跨线程/跨窗口复用）", () => {
  beforeEach(() => {
    __resetAutoSessionForTests();
    resetSessionStats();
    __setAutoSessionNow(() => 1_000_000);
  });
  afterAll(() => {
    __resetAutoSessionForTests();
    resetSessionStats();
    __setAutoSessionNow(() => Date.now());
  });

  it("auto 关闭时：thread-A 签发的 sid 在 thread-B 复用 → rejected，不落回 raw", () => {
    const cfg = { enabled: true, ttlMinutes: 30 } as const;
    const issued = resolveOrCreateSessionId(null, "k", cfg, undefined, "thread-A");
    const replay = resolveOrCreateSessionId(issued.sessionId, "k", { enabled: false }, undefined, "thread-B");
    expect(replay.rejected).toBe(true);
    expect(replay.sessionId).toBe("");
    expect(getSessionStats().scopeRejected).toBeGreaterThan(0);
  });

  it("per-key-msg：不同首问指纹的 sid 不能互相续接（防跨窗口泄漏）", () => {
    const cfg = { enabled: true, ttlMinutes: 30, strategy: "per-key-msg" } as const;
    const issued = resolveOrCreateSessionId(null, "k", cfg, "fp-q1", "th-1");
    const replay = resolveOrCreateSessionId(issued.sessionId, "k", { enabled: false }, "fp-q2", "th-1");
    expect(replay.rejected).toBe(true);
    expect(replay.sessionId).toBe("");
    expect(getSessionStats().scopeRejected).toBeGreaterThan(0);
  });

  it("同 scope + 同指纹（续接）不被误拒", () => {
    const cfg = { enabled: true, ttlMinutes: 30, strategy: "per-key-msg" } as const;
    const issued = resolveOrCreateSessionId(null, "k", cfg, "fp-q1", "th-1");
    const resume = resolveOrCreateSessionId(issued.sessionId, "k", cfg, "fp-q1", "th-1");
    expect(resume.rejected).toBeUndefined();
    expect(resume.sessionId).toBe(issued.sessionId);
  });
});

describe("ghost 回退修复 + 指纹全文本", () => {
  beforeEach(() => {
    __resetAutoSessionForTests();
    resetSessionStats();
    __setAutoSessionNow(() => 1_000_000);
  });
  afterAll(() => {
    __resetAutoSessionForTests();
    resetSessionStats();
    __setAutoSessionNow(() => Date.now());
  });

  it("auto 关闭 + 旧 key 签发的 auto- ID → resolveEffectiveConversationId 返回 null（不再落回 raw）", () => {
    const cfg = { enabled: true, ttlMinutes: 30 } as const;
    const ghost = resolveOrCreateSessionId(null, "other-key", cfg); // 属于其它 key 的 auto- ID
    const ctx = {
      req: { header: (n: string) => (n === "x-conversation-id" ? ghost.sessionId : null) },
    } as never;
    const r = resolveEffectiveConversationId(ctx, "k", { sessionInit: { autoConversationId: { enabled: false } } } as never);
    expect(r.conversationId).toBeNull();
    expect(getSessionStats().ghostRejected).toBeGreaterThan(0);
  });

  it("首问指纹：前 512 字符相同、后续不同 → 指纹不同（防长文截断合并窗口）", () => {
    const head = "x".repeat(512);
    const f1 = firstUserMessageFingerprint([{ role: "user", content: head + "AAA" }]);
    const f2 = firstUserMessageFingerprint([{ role: "user", content: head + "BBB" }]);
    expect(f1).not.toBe(f2);
  });

  it("首问指纹：空白折叠后归一（不影响语义区分）", () => {
    const f1 = firstUserMessageFingerprint([{ role: "user", content: "  a   b\n\n c  " }]);
    const f2 = firstUserMessageFingerprint([{ role: "user", content: "a b c" }]);
    expect(f1).toBe(f2);
  });

  it("首问指纹：harness wrapper 剥离后与纯用户文本等价（对齐 L0 抽取语义）", () => {
    const plain = firstUserMessageFingerprint([{ role: "user", content: "帮我重构这个函数" }]);
    const wrapped = firstUserMessageFingerprint([
      {
        role: "user",
        content:
          "<system-reminder>当前时间: 2026-09-02 13:00</system-reminder>" +
          "<user_query>帮我重构这个函数</user_query>",
      },
    ]);
    expect(wrapped).toBe(plain);
    expect(plain).toBeDefined();
  });

  it("首问指纹：纯 wrapper 无用户文本 → undefined（不回退噪音指纹）", () => {
    const f = firstUserMessageFingerprint([
      { role: "user", content: "<system_reminder>仅内部提示，勿回复</system_reminder>" },
    ]);
    expect(f).toBeUndefined();
  });
});

describe("会话结束台账 + 归属分解计数", () => {
  beforeEach(() => {
    __resetAutoSessionForTests();
    resetSessionStats();
    __setAutoSessionNow(() => 1_000_000);
  });
  afterAll(() => {
    __resetAutoSessionForTests();
    resetSessionStats();
    __setAutoSessionNow(() => Date.now());
  });

  it("TTL 过期命中：旧 sid 进入台账（reason=expired），新会话隔离", () => {
    const cfg = { enabled: true, ttlMinutes: 30 } as const;
    const first = resolveOrCreateSessionId(null, "k", cfg);
    __setAutoSessionNow(() => 1_000_000 + 30 * 60_000 + 1);
    const second = resolveOrCreateSessionId(null, "k", cfg);
    expect(second.sessionId).not.toBe(first.sessionId);
    const ledger = recentExpiredSessions();
    expect(ledger.some((e) => e.sid === first.sessionId && e.reason === "expired")).toBe(true);
  });

  it("pruneExpiredSessions：被清理的会话入台账（reason=pruned）", () => {
    const cfg = { enabled: true, ttlMinutes: 30 } as const;
    const sid = resolveOrCreateSessionId(null, "k", cfg).sessionId;
    __setAutoSessionNow(() => 1_000_000 + 30 * 60_000 + 1);
    expect(pruneExpiredSessions(30)).toBe(1);
    expect(recentExpiredSessions().some((e) => e.sid === sid && e.reason === "pruned")).toBe(true);
  });

  it("agentSource / spaceId 分解计数与全局计数同步", () => {
    const cfg = { enabled: true, ttlMinutes: 30 } as const;
    const meta = { agentSource: "codex", spaceId: "sp-1" };
    resolveOrCreateSessionId(null, "k", cfg, undefined, "", meta);
    const { byAgent, bySpace } = getSessionStatsBreakdown();
    expect(byAgent.codex.created).toBeGreaterThan(0);
    expect(bySpace["sp-1"].created).toBeGreaterThan(0);
    expect(getSessionStats().created).toBeGreaterThan(0);
  });

  it("窗口/容量淘汰的会话也进台账（reason=evicted）", () => {
    const cfg = {
      enabled: true,
      ttlMinutes: 30,
      strategy: "per-key-msg",
      maxWindowsPerKey: 1,
    } as const;
    resolveOrCreateSessionId(null, "k", cfg, "fp-1", "th-1");
    const second = resolveOrCreateSessionId(null, "k", cfg, "fp-2", "th-1");
    expect(second.sessionId).not.toBe("");
    const ledger = recentExpiredSessions();
    expect(ledger.some((e) => e.reason === "evicted")).toBe(true);
  });
});

describe("deterministicBucketMinutes 配置校验", () => {
  it("非法桶宽 / 桶宽小于 ttlMinutes 抛错；合法值放行", () => {
    expect(() =>
      validateAutoConversationConfig({ ttlMinutes: 30, deterministicBucketMinutes: 10 }),
    ).toThrow(/ttlMinutes/);
    expect(() =>
      validateAutoConversationConfig({ ttlMinutes: 30, deterministicBucketMinutes: 0 }),
    ).toThrow(/正整数/);
    expect(() =>
      validateAutoConversationConfig({ ttlMinutes: 30, deterministicBucketMinutes: 60 }),
    ).not.toThrow();
  });
});

describe("sessionStatsToPrometheus 输出格式", () => {
  beforeEach(() => {
    __resetAutoSessionForTests();
    resetSessionStats();
  });
  afterAll(() => {
    __resetAutoSessionForTests();
    resetSessionStats();
  });

  it("space 标签超过 32 个时只导出前 32 + exceed 计数", () => {
    for (let i = 0; i < 40; i++) {
      recordSession("created", 1, { agentSource: "codex", spaceId: `sp-${i}` });
    }
    const out = sessionStatsToPrometheus();
    const spaceLines = out
      .split("\n")
      .filter((l) => l.includes("_space{space="));
    expect(spaceLines.length).toBe(32);
    expect(out).toContain("tdai_auto_session_spaces_exceeded_total 8");
    expect(out).toContain('tdai_auto_session_created_total_agent{agent="codex"} 40');
  });

  it("reuse_rate / fence 计数行存在且格式合法", () => {
    recordSession("created", 1);
    recordSession("resumed", 3);
    recordSession("fenceBlocked", 2);
    recordSession("fenceAllowed", 8);
    const out = sessionStatsToPrometheus();
    expect(out).toContain("tdai_auto_session_reuse_rate 0.7500");
    expect(out).toContain("tdai_auto_session_fence_blocked_total 2");
    expect(out).toContain("tdai_auto_session_fence_allowed_total 8");
    expect(out).toContain("tdai_auto_session_scope_rejected_total 0");
  });
});
