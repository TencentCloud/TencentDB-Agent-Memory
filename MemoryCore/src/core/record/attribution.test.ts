// 确定性归属护栏回归（2026-09-24 实测事故驱动）：
// 模型把角色标签/路径数字/时间状语/命理原文塞进「用户（X）」的姓名括号，
// 产出「用户（导师）」「用户（28951）」这类身份误归属。入库前必须归一。
import { describe, it, expect } from "vitest";
import { sanitizeUserAttribution } from "./attribution.js";

const ALLOW = ["何伟健", "heweijian", "Weijian He"];

describe("sanitizeUserAttribution", () => {
  it("白名单内的真实姓名原样保留（大小写/空格容忍）", () => {
    expect(sanitizeUserAttribution("用户（何伟健）在开发 it-ops", ALLOW).text).toBe("用户（何伟健）在开发 it-ops");
    expect(sanitizeUserAttribution("The user (HeWeiJian) ships panels", ALLOW).text).toBe("The user (HeWeiJian) ships panels");
    expect(sanitizeUserAttribution("用户（ 何伟健 ）偏好验证", ALLOW).text).toBe("用户（ 何伟健 ）偏好验证");
  });

  it("第三方真实姓名 → 归一为「用户」（回传被丢弃标签）", () => {
    const r = sanitizeUserAttribution("用户（王缘林）要求扩大处理人配置范围", ALLOW);
    expect(r.text).toBe("用户要求扩大处理人配置范围");
    expect(r.dropped).toEqual(["王缘林"]);
    // 带 pinyin 逗号别名也要整段丢
    const r2 = sanitizeUserAttribution("用户（王缘林，wangyuanlin）在本地运行 it-ops", ALLOW);
    expect(r2.text).toBe("用户在本地运行 it-ops");
    expect(r2.dropped).toEqual(["王缘林，wangyuanlin"]);
  });

  it("角色标签（护栏新堵的漏洞）→ 归一为「用户」", () => {
    for (const label of ["导师", "开发者", "学习者", "实习生", "领导"]) {
      const r = sanitizeUserAttribution(`用户（${label}）提出了需求`, ALLOW);
      expect(r.text).toBe("用户提出了需求");
      expect(r.dropped).toEqual([label]);
    }
  });

  it("路径数字/时间状语/命理原文等非姓名垃圾 → 归一为「用户」", () => {
    expect(sanitizeUserAttribution("用户（28951）在维护 OpenCode 额度面板", ALLOW).text).toBe("用户在维护 OpenCode 额度面板");
    expect(sanitizeUserAttribution("用户（在 2026 年 9 月 24 日）提交了批量", ALLOW).text).toBe("用户提交了批量");
    const bazi = sanitizeUserAttribution("用户（乾造甲申丁卯丙午庚寅，日主丙火身旺）的命盘", ALLOW);
    expect(bazi.text).toBe("用户的命盘");
    expect(bazi.dropped[0]).toContain("日主丙火身旺");
  });

  it("自指标签归一（用户（用户）/（本人））", () => {
    expect(sanitizeUserAttribution("用户（用户）有验证纪律", ALLOW).text).toBe("用户有验证纪律");
    expect(sanitizeUserAttribution("用户（本人）决定用双轨", ALLOW).text).toBe("用户决定用双轨");
  });

  it("空白名单 = 默认全归一（未配置即最严）", () => {
    const r = sanitizeUserAttribution("用户（何伟健）测试", []);
    expect(r.text).toBe("用户测试");
    expect(r.dropped).toEqual(["何伟健"]);
  });

  it("同句多处只回传一次标签；无括号零改动", () => {
    const r = sanitizeUserAttribution("用户（导师）说 A；用户（导师）说 B；用户喜欢 C", ALLOW);
    expect(r.text).toBe("用户说 A；用户说 B；用户喜欢 C");
    expect(r.dropped).toEqual(["导师"]);
    const none = sanitizeUserAttribution("用户喜欢验证纪律，无括号", ALLOW);
    expect(none.text).toBe("用户喜欢验证纪律，无括号");
    expect(none.dropped).toEqual([]);
  });

  it("AI 主体不受影响（只管「用户（X）」）", () => {
    const t = "AI 建议用户（王缘林）确认后继续";
    expect(sanitizeUserAttribution(t, ALLOW).text).toBe("AI 建议用户确认后继续");
  });
});
