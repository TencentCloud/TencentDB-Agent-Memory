/**
 * #1708 回归测试：Chat_Memory L2 条目标题行的键盘分发规则。
 *
 * 走查链路：BlockDetail.tsx 的 AtomicHead 在 `role="button"` 的行上绑 onKeyDown，
 * 只在 shouldHandleRowKeydown 为真时 preventDefault + onToggle；调用点正是这里被测的纯函数。
 * 真实 DOM 冒泡无法在 node 环境复现，本测试覆盖判定规则本身。
 */
import { describe, expect, it } from "vitest";
import {
  isActivationKey,
  shouldHandleRowKeydown,
} from "../web/src/pages/ChatMemoryPage/utils/atomic-head-keyboard";

const row = { kind: "row" };
const moreButton = { kind: "more-button" };
const chevron = { kind: "chevron" };

describe("isActivationKey", () => {
  it("recognises Enter and Space only", () => {
    expect(isActivationKey("Enter")).toBe(true);
    expect(isActivationKey(" ")).toBe(true);
    for (const key of ["Spacebar", "Tab", "Escape", "a", "ArrowDown", ""]) {
      expect(isActivationKey(key)).toBe(false);
    }
  });
});

describe("shouldHandleRowKeydown", () => {
  it("handles Enter/Space when the row itself has focus", () => {
    expect(
      shouldHandleRowKeydown({ key: "Enter", target: row, currentTarget: row }),
    ).toBe(true);
    expect(
      shouldHandleRowKeydown({ key: " ", target: row, currentTarget: row }),
    ).toBe(true);
  });

  it("lets nested controls keep their native activation (#1708)", () => {
    // Enter/Space 冒泡自「更多操作」按钮：父级必须放行，否则菜单打不开还会折叠整行。
    expect(
      shouldHandleRowKeydown({
        key: "Enter",
        target: moreButton,
        currentTarget: row,
      }),
    ).toBe(false);
    expect(
      shouldHandleRowKeydown({
        key: " ",
        target: moreButton,
        currentTarget: row,
      }),
    ).toBe(false);
    // chevron 同理（它有自己独立的 onKeyDown，父级不应插手）。
    expect(
      shouldHandleRowKeydown({
        key: "Enter",
        target: chevron,
        currentTarget: row,
      }),
    ).toBe(false);
    expect(
      shouldHandleRowKeydown({ key: " ", target: chevron, currentTarget: row }),
    ).toBe(false);
  });

  it("ignores non-activation keys even on the row itself", () => {
    for (const key of ["Tab", "Escape", "ArrowDown", "Spacebar"]) {
      expect(
        shouldHandleRowKeydown({ key, target: row, currentTarget: row }),
      ).toBe(false);
    }
  });

  it("ignores nested non-activation keys too", () => {
    expect(
      shouldHandleRowKeydown({
        key: "Escape",
        target: moreButton,
        currentTarget: row,
      }),
    ).toBe(false);
  });
});
