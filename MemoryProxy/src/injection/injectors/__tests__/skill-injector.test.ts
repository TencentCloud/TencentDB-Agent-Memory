import { describe, expect, it } from "vitest";
import { SKILL_QUEUE_END, SKILL_QUEUE_START, hasSkillQueueMarkers, stripSkillQueueBlocks } from "../../../common/skill-queue-markers.js";

describe("skill queue markers", () => {
  it("recognizes and removes only proxy-owned suffixes", () => {
    const injected = `${SKILL_QUEUE_START}\n<available_skills>\n- a\n</available_skills>\n${SKILL_QUEUE_END}`;
    const text = `用户原文 ${injected}`;
    expect(hasSkillQueueMarkers(text)).toBe(true);
    expect(stripSkillQueueBlocks(text)).toBe("用户原文");
  });
  it("leaves ordinary user text unchanged", () => {
    const text = "用户自己写的 <available_skills> 说明";
    expect(hasSkillQueueMarkers(text)).toBe(false);
    expect(stripSkillQueueBlocks(text)).toBe(text);
  });

  it("does not treat an incomplete marker as a Proxy block", () => {
    const text = `用户原文 ${SKILL_QUEUE_START}\n用户自己的内容`;
    expect(hasSkillQueueMarkers(text)).toBe(false);
    expect(stripSkillQueueBlocks(text)).toBe(text);
  });
  it("removes multiple historical suffixes", () => {
    const one = `${SKILL_QUEUE_START}\none\n${SKILL_QUEUE_END}`;
    const two = `${SKILL_QUEUE_START}\ntwo\n${SKILL_QUEUE_END}`;
    expect(stripSkillQueueBlocks(`q1 ${one}\nq2 ${two}`)).toBe("q1 q2");
  });

  it("removes the Responses wrapper around a queue suffix", () => {
    const wrapped = `<tdai_injections>\n${SKILL_QUEUE_START}\nlist\n${SKILL_QUEUE_END}\n</tdai_injections>`;
    expect(stripSkillQueueBlocks(`用户原文\n${wrapped}`)).toBe("用户原文");
  });
});
