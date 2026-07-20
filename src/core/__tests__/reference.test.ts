import { describe, it, expect } from "vitest";
import { buildReferenceProfile, referencePromptSection } from "../reference";
import type { Transcript } from "../../shared/api-types";

/** 极简逐句稿工厂(words 为空——画像只吃句级数据)。 */
const t = (
  segments: Array<{ start: number; end: number; text: string }>,
  language = "zh",
  durationSec?: number
): Transcript => ({
  language,
  engine: "test",
  durationSec: durationSec ?? (segments.length > 0 ? segments[segments.length - 1].end : 0),
  segments: segments.map((s, i) => ({ id: i + 1, startSec: s.start, endSec: s.end, text: s.text, words: [] })),
});

describe("buildReferenceProfile (画像实测)", () => {
  it("中文按字计:语速用说话时段,句长为均值,钩子取首句", () => {
    // 两句各 10 个汉字;说话时段 4s+4s=8s → 语速 2.5 字/秒
    const p = buildReferenceProfile(
      t([
        { start: 0, end: 4, text: "这个价格你敢信是真的吗" }, // 11 字含"吗"
        { start: 5, end: 9, text: "今天就给大家把话说明白" }, // 11 字
      ]),
      [1.2, 3.4, 6.8]
    );
    expect(p.zh).toBe(true);
    expect(p.durationSec).toBe(9);
    expect(p.speechRate).toBe(2.8); // 22 字 / 8 秒说话时段,保留一位小数
    expect(p.avgSentenceLen).toBe(11);
    expect(p.hookLine).toBe("这个价格你敢信是真的吗");
    // 3 个镜头边界 / 9 秒 = 20 切/分
    expect(p.cutsPerMin).toBeCloseTo(20, 0);
  });

  it("英文按词计;镜头检测失败为 null 维度", () => {
    const p = buildReferenceProfile(
      t([{ start: 0, end: 5, text: "you will not believe this price" }], "en"),
      null
    );
    expect(p.zh).toBe(false);
    expect(p.speechRate).toBeCloseTo(6 / 5, 1);
    expect(p.avgSentenceLen).toBe(6);
    expect(p.cutsPerMin).toBeNull();
  });

  it("空逐句稿不炸:全零画像", () => {
    const p = buildReferenceProfile(t([]), []);
    expect(p.durationSec).toBe(0);
    expect(p.speechRate).toBe(0);
    expect(p.avgSentenceLen).toBe(0);
    expect(p.cutsPerMin).toBeNull(); // durationSec≤3 不给切换频率
    expect(p.hookLine).toBe("");
  });
});

describe("referencePromptSection (提示词段落)", () => {
  const profile = buildReferenceProfile(
    t([
      { start: 0, end: 10, text: "这个价格你敢信是真的吗" },
      { start: 10, end: 30, text: "今天就给大家把话说明白不玩虚的" },
    ]),
    Array.from({ length: 15 }, (_, i) => i * 2)
  );

  it("中文段落:含实测维度与 ±30% 目标时长,声明偏好不是硬约束", () => {
    const s = referencePromptSection(profile, true);
    expect(s).toContain("参考爆款画像");
    expect(s).toContain("时长 30 秒");
    expect(s).toContain("21~39 秒"); // 30 的 ±30%
    expect(s).toContain("镜头切换 30 次/分钟");
    expect(s).toContain("这个价格你敢信是真的吗");
    expect(s).toContain("偏好不是硬约束");
  });

  it("英文段落:同样含目标区间与非硬约束声明", () => {
    const s = referencePromptSection(profile, false);
    expect(s).toContain("Reference clip profile");
    expect(s).toContain("21–39s");
    expect(s).toContain("not a hard rule");
  });

  it("镜头维度缺失时不输出该项", () => {
    const noCuts = { ...profile, cutsPerMin: null };
    expect(referencePromptSection(noCuts, true)).not.toContain("镜头切换");
  });
});
