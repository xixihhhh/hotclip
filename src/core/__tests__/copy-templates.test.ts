import { describe, it, expect } from "vitest";
import {
  isHookAngle,
  isCtaType,
  hookAngleMenu,
  ctaMenu,
  hookAngleLabel,
  ctaTypeLabel,
} from "../copy-templates";

describe("校验器", () => {
  it("菜单内 id 通过,菜单外/非字符串拒绝", () => {
    expect(isHookAngle("question")).toBe(true);
    expect(isHookAngle("urgency")).toBe(true);
    expect(isHookAngle("clickbait")).toBe(false);
    expect(isHookAngle(1)).toBe(false);
    expect(isCtaType("product")).toBe(true);
    expect(isCtaType("buy_now")).toBe(false);
    expect(isCtaType(undefined)).toBe(false);
  });
});

describe("提示词菜单", () => {
  it("中文菜单 8 角度 5 CTA,每行带 id 与用法", () => {
    const angles = hookAngleMenu(true).split("\n");
    expect(angles.length).toBe(8);
    expect(angles[0]).toContain("question=提问式");
    const ctas = ctaMenu(true).split("\n");
    expect(ctas.length).toBe(5);
    expect(ctas.some((l) => l.startsWith("product=商品引导"))).toBe(true);
  });

  it("高危角度/CTA 的提示里带红线(与违禁词 lint 呼应)", () => {
    expect(hookAngleMenu(true)).toContain("禁编造截止");
    expect(ctaMenu(true)).toContain("禁站外导流");
  });

  it("英文菜单同样成行", () => {
    expect(hookAngleMenu(false).split("\n").length).toBe(8);
    expect(ctaMenu(false).split("\n").length).toBe(5);
  });
});

describe("标签", () => {
  it("已知 id 出人类可读名,未知 id 原样返回", () => {
    expect(hookAngleLabel("pain", true)).toBe("痛点共鸣");
    expect(hookAngleLabel("pain", false)).toBe("pain");
    expect(ctaTypeLabel("save", true)).toBe("收藏回看");
    expect(hookAngleLabel("mystery", true)).toBe("mystery");
  });
});
