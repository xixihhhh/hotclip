/**
 * v0.14 第二批:说话人标签字幕(对谈静音观看)/跳剪保留呼吸口/模板受控微扰。
 */
import { describe, it, expect } from "vitest";
import { buildCaptionAss, createSpeakerLabeler, lineSpeaker, VERTICAL_LAYOUT } from "../subtitle";
import { computeJumpCut } from "../gaps";
import { perturbLayout, fnv1a, mulberry32, JITTER_FONT_SPAN, JITTER_BASELINE_FRAC, JITTER_MARGIN_H_PX } from "../../shared/perturb";
import type { TranscriptWord } from "../../shared/api-types";

const w = (text: string, startSec: number, endSec: number, speaker?: number): TranscriptWord =>
  speaker === undefined ? { text, startSec, endSec } : { text, startSec, endSec, speaker };

describe("lineSpeaker(行内主导说话人)", () => {
  it("按词时长多数票;无标注返回 undefined", () => {
    expect(lineSpeaker([w("短", 0, 0.2, 1), w("长长长", 0.2, 2, 0)])).toBe(0);
    expect(lineSpeaker([w("无", 0, 1)])).toBeUndefined();
  });
});

describe("createSpeakerLabeler(说话人标签器)", () => {
  const twoSpeakers = [w("你好。", 0, 1, 0), w("在吗。", 1, 2, 1), w("在的。", 2, 3, 1)];
  it("换人才出标签,同人连续行不刷屏;字母按首次发言顺序", () => {
    const label = createSpeakerLabeler(twoSpeakers, true);
    expect(label([twoSpeakers[0]])).toContain("A:");
    expect(label([twoSpeakers[1]])).toContain("B:");
    expect(label([twoSpeakers[2]])).toBe(""); // 还是 B 在说
  });
  it("首个发言者永远是 A(与 diarize 的簇 id 数值无关)", () => {
    const ids = [w("一", 0, 1, 3), w("二", 1, 2, 0)];
    const label = createSpeakerLabeler(ids, true);
    expect(label([ids[0]])).toContain("A:");
    expect(label([ids[1]])).toContain("B:");
  });
  it("单说话人/未开启不产标签", () => {
    const solo = [w("一", 0, 1, 0), w("二", 1, 2, 0)];
    expect(createSpeakerLabeler(solo, true)([solo[0]])).toBe("");
    expect(createSpeakerLabeler(twoSpeakers, false)([twoSpeakers[0]])).toBe("");
  });
  it("A 与 B 的标签颜色不同", () => {
    const label = createSpeakerLabeler(twoSpeakers, true);
    const a = label([twoSpeakers[0]]);
    const b = label([twoSpeakers[1]]);
    const colorOf = (tag: string): string => tag.match(/\\c(&H[0-9A-F]+&)/i)?.[1] ?? "";
    expect(colorOf(a)).not.toBe("");
    expect(colorOf(a)).not.toBe(colorOf(b));
  });
});

describe("buildCaptionAss + 说话人标签", () => {
  const words = [w("你好。", 0, 1, 0), w("在吗。", 1.2, 2, 1), w("在的。", 2.2, 3, 1)];
  it("keyword 样式:换人行首出彩色标签,各一次", () => {
    const ass = buildCaptionAss(words, 0, VERTICAL_LAYOUT, "keyword", { speakerLabels: true });
    expect(ass.match(/\\fscy85\}A:\{/g)).toHaveLength(1);
    expect(ass.match(/\\fscy85\}B:\{/g)).toHaveLength(1);
  });
  it("pop 短块样式同样带标签;没开则不带", () => {
    const withTag = buildCaptionAss(words, 0, VERTICAL_LAYOUT, "pop", { speakerLabels: true });
    expect(withTag).toContain("}A:{");
    const off = buildCaptionAss(words, 0, VERTICAL_LAYOUT, "keyword", {});
    expect(off).not.toContain("}A:{");
  });
});

describe("computeJumpCut 保留呼吸口 + speaker 透传", () => {
  const words = [w("aaa", 0.5, 5, 0), w("bbb", 7, 9, 1)];
  it("breathPadSec 让每个剪口多留一口气(时长差恰为呼吸量)", () => {
    const tight = computeJumpCut(words, 0, 10, {});
    const breath = computeJumpCut(words, 0, 10, { breathPadSec: 0.25 });
    expect(tight.segments).toHaveLength(2);
    expect(breath.segments).toHaveLength(2);
    expect(breath.durationSec).toBeCloseTo(tight.durationSec + 0.25, 5);
    expect(breath.removedSec).toBeCloseTo(tight.removedSec - 0.25, 5);
  });
  it("压缩时间轴上的词保留 speaker 标注(字幕标签/着色靠它)", () => {
    const plan = computeJumpCut(words, 0, 10, {});
    expect(plan.words.map((x) => x.speaker)).toEqual([0, 1]);
  });
});

describe("perturbLayout(模板受控微扰)", () => {
  const base = { playResX: 1080, playResY: 1920, fontSize: 78, marginV: 560, marginH: 60, outline: 4, maxLineUnits: 22 };
  it("同种子确定性复现;不改入参", () => {
    const a = perturbLayout(base, "video.mp4#1");
    const b = perturbLayout(base, "video.mp4#1");
    expect(a).toEqual(b);
    expect(base.fontSize).toBe(78);
    expect(base.marginV).toBe(560);
  });
  it("不同切片得到不同版式(至少一个种子与 #0 不同)", () => {
    const ref = perturbLayout(base, "video.mp4#0");
    const anyDiff = [1, 2, 3, 4].some((i) => {
      const p = perturbLayout(base, `video.mp4#${i}`);
      return p.fontSize !== ref.fontSize || p.marginV !== ref.marginV || p.marginH !== ref.marginH;
    });
    expect(anyDiff).toBe(true);
  });
  it("抖动幅度受控:字号 ±4%、基线不出 62-72% 安全带、边距有下限", () => {
    for (let i = 0; i < 50; i++) {
      const p = perturbLayout(base, `seed#${i}`);
      expect(Math.abs(p.fontSize - base.fontSize)).toBeLessThanOrEqual(Math.ceil(base.fontSize * JITTER_FONT_SPAN) + 1);
      expect(Math.abs(p.marginV - base.marginV)).toBeLessThanOrEqual(Math.ceil(base.playResY * JITTER_BASELINE_FRAC) + 1);
      const baselineFrac = (p.playResY - p.marginV) / p.playResY;
      expect(baselineFrac).toBeGreaterThan(0.62);
      expect(baselineFrac).toBeLessThan(0.725);
      expect(Math.abs(p.marginH - base.marginH)).toBeLessThanOrEqual(JITTER_MARGIN_H_PX);
      expect(p.marginH).toBeGreaterThanOrEqual(20);
      // 与布局几何无关的字段原样保留
      expect(p.maxLineUnits).toBe(base.maxLineUnits);
      expect(p.playResY).toBe(base.playResY);
    }
  });
  it("fnv1a/mulberry32 基本性质:同入同出,输出在 [0,1)", () => {
    expect(fnv1a("abc")).toBe(fnv1a("abc"));
    expect(fnv1a("abc")).not.toBe(fnv1a("abd"));
    const rand = mulberry32(fnv1a("abc"));
    for (let i = 0; i < 100; i++) {
      const v = rand();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
