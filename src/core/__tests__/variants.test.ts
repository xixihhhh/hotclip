/**
 * 一片多版:变体计划解析、spec 展开、封面分峰。多账号分发的差异化靠
 * 「角度/标题/封面/文案都真的不同」,展开逻辑错了(id 撞车/封面同帧/
 * 变体混进合集)整个玩法就穿帮。
 */
import { describe, it, expect } from "vitest";
import { variantSystemPrompt, parseVariantPlans, expandClipSpecs, generateVariantPlans, VARIANT_TOTAL_MAX } from "../variants";
import { pickCoverTime } from "../cover";
import type { ExportClipSpec } from "../export";
import type { PeakTrack } from "../audio-peaks";

const spec = (id: number, title: string): ExportClipSpec => ({
  id,
  title,
  startSec: 10,
  endSec: 30,
  publish: { title: `原文案${id}`, hashtags: ["#原"], description: "d" },
  meta: { hook: "h", score: 90, reason: "r", text: "t", recommended: true, reviewNote: "", teaser: "原悬念" },
});

const PLAN_JSON = JSON.stringify({
  clips: [
    {
      id: 1,
      variants: [
        { title: "反差版标题", teaser: "变体悬念", post: { title: "发布B", hashtags: ["#b"], description: "db", angle: "contrast" } },
        { title: "提问版标题", post: { title: "发布C", hashtags: ["#c"], description: "dc", angle: "question" } },
      ],
    },
  ],
});

describe("variantSystemPrompt", () => {
  it("中文提示词讲清「换角度不是改写」并带角度菜单与份数", () => {
    const p = variantSystemPrompt(true, 2);
    expect(p).toContain("2 套");
    expect(p).toContain("question=提问式");
    expect(p).toContain("不是同义改写");
  });
});

describe("parseVariantPlans", () => {
  it("解析变体,teaser 可省略,post 走发布文案同一套校验", () => {
    const out = parseVariantPlans(PLAN_JSON, new Set([1]), 2);
    const vs = out.get(1)!;
    expect(vs).toHaveLength(2);
    expect(vs[0].teaser).toBe("变体悬念");
    expect(vs[1].teaser).toBeUndefined();
    expect(vs[0].post!.angle).toBe("contrast");
  });

  it("超出每片上限截断;瞎编的 id 丢弃", () => {
    const many = JSON.stringify({
      clips: [
        { id: 1, variants: [{ title: "a" }, { title: "b" }, { title: "c" }] },
        { id: 99, variants: [{ title: "x" }] },
      ],
    });
    const out = parseVariantPlans(many, new Set([1]), 2);
    expect(out.get(1)).toHaveLength(2);
    expect(out.has(99)).toBe(false);
  });

  it("整体不是 JSON 时抛错(上层借此重发一次)", () => {
    expect(() => parseVariantPlans("我觉得都挺好", new Set([1]), 2)).toThrow();
  });

  it("generateVariantPlans:第一次吐杂质第二次干净 → 重试后成功(fail-open 口径)", async () => {
    let calls = 0;
    const chat = async (): Promise<string> => {
      calls++;
      return calls === 1 ? '{"clips":[{"id": vii}]}' : PLAN_JSON;
    };
    const out = await generateVariantPlans(
      [{ id: 1, title: "原标题", hook: "h", text: "t", keywords: [] }],
      3,
      true,
      { baseUrl: "http://x", apiKey: "k", model: "m" },
      chat
    );
    expect(calls).toBe(2);
    expect(out!.get(1)).toHaveLength(2);
  });

  it("generateVariantPlans:两次都是垃圾返回 null,绝不抛(导出照常)", async () => {
    const out = await generateVariantPlans(
      [{ id: 1, title: "t", hook: "h", text: "t", keywords: [] }],
      2,
      true,
      { baseUrl: "http://x", apiKey: "k", model: "m" },
      async () => "不是JSON"
    );
    expect(out).toBeNull();
  });
});

describe("expandClipSpecs", () => {
  const plans = parseVariantPlans(PLAN_JSON, new Set([1]), 2);

  it("变体紧跟原版,id 从最大值续编,版本号从2起,封面峰错开", () => {
    const out = expandClipSpecs([spec(1, "原标题"), spec(7, "另一条")], plans, true);
    expect(out.map((s) => s.title)).toEqual(["原标题", "反差版标题", "提问版标题", "另一条"]);
    expect(out[1].id).toBe(8);
    expect(out[2].id).toBe(9);
    expect(out[1].variantOf).toBe(1);
    expect(out[1].variant).toBe(2);
    expect(out[2].variant).toBe(3);
    expect(out[1].coverRank).toBe(1);
    expect(out[2].coverRank).toBe(2);
    // 切点/词表原样克隆——变体只是包装不同,内容完全一致
    expect(out[1].startSec).toBe(10);
    expect(out[1].endSec).toBe(30);
  });

  it("变体的悬念句/文案换成自己的;没给的沿用原版", () => {
    const out = expandClipSpecs([spec(1, "原标题")], plans, true);
    expect(out[1].meta!.teaser).toBe("变体悬念");
    expect(out[2].meta!.teaser).toBe("原悬念");
    expect(out[1].publish!.title).toBe("发布B");
  });

  it("没开发布文案时变体也不带文案(与原版行为一致)", () => {
    const out = expandClipSpecs([spec(1, "原标题")], plans, false);
    expect(out[1].publish).toBeUndefined();
  });

  it("与原标题一字不差的变体丢弃(没有差异化价值)", () => {
    const lazy = new Map([[1, [{ title: "原标题" }, { title: "真的不同" }]]]);
    const out = expandClipSpecs([spec(1, "原标题")], lazy, true);
    expect(out).toHaveLength(2);
    expect(out[1].title).toBe("真的不同");
  });

  it("总版本数上限是 3(含原版)", () => {
    expect(VARIANT_TOTAL_MAX).toBe(3);
  });

  it("flashDim:最后一版换开场结构(爆点闪现),其余版与原版不动", () => {
    const out = expandClipSpecs([spec(1, "原标题")], plans, true, true);
    expect(out.map((s) => Boolean(s.flashForward))).toEqual([false, false, true]);
  });

  it("flashDim 关(全局闪现已开)时不叠结构差异,行为与历史一致", () => {
    const out = expandClipSpecs([spec(1, "原标题")], plans, true);
    expect(out.every((s) => !s.flashForward)).toBe(true);
  });

  it("flashDim + 与原标题重复的变体被丢弃后,闪现落在真正的最后一版上", () => {
    const lazy = new Map([[1, [{ title: "原标题" }, { title: "真的不同" }]]]);
    const out = expandClipSpecs([spec(1, "原标题")], lazy, true, true);
    expect(out).toHaveLength(2);
    expect(Boolean(out[0].flashForward)).toBe(false);
    expect(out[1].flashForward).toBe(true);
  });
});

describe("pickCoverTime 分峰", () => {
  // 三个明显分离的峰:8s(最高)、3s(次高)、14s(第三)
  const peaks: PeakTrack = {
    startSec: 0,
    hopSec: 1,
    values: Float32Array.from([0.1, 0.1, 0.1, 0.7, 0.1, 0.1, 0.1, 0.1, 0.9, 0.1, 0.1, 0.1, 0.1, 0.1, 0.5, 0.1, 0.1, 0.1, 0.1, 0.1]),
  };
  const ranges = [{ startSec: 0, endSec: 20 }];

  it("rank 0 与历史行为一致:取最高峰", () => {
    expect(pickCoverTime(peaks, ranges, 20, 0)).toBe(8);
    expect(pickCoverTime(peaks, ranges, 20)).toBe(8); // 缺省参数不变
  });

  it("rank 1/2 取次高/第三峰——变体封面真的不同帧", () => {
    expect(pickCoverTime(peaks, ranges, 20, 1)).toBe(3);
    expect(pickCoverTime(peaks, ranges, 20, 2)).toBe(14);
  });

  it("峰不够多时用最后一个可用的,不越界不炸", () => {
    expect(pickCoverTime(peaks, ranges, 20, 99)).toBe(14);
  });

  it("紧挨着的采样点算同一个峰,不会三版封面挤在同一秒", () => {
    const cluster: PeakTrack = { startSec: 0, hopSec: 0.5, values: Float32Array.from([0.1, 0.9, 0.85, 0.8, 0.1, 0.1, 0.1, 0.6, 0.1, 0.1]) };
    const a = pickCoverTime(cluster, [{ startSec: 0, endSec: 5 }], 5, 0);
    const b = pickCoverTime(cluster, [{ startSec: 0, endSec: 5 }], 5, 1);
    expect(Math.abs(a - b)).toBeGreaterThanOrEqual(1.5);
  });

  it("全静音回退固定帧(与历史一致)", () => {
    const silent: PeakTrack = { startSec: 0, hopSec: 1, values: Float32Array.from([0.01, 0.02, 0.01]) };
    expect(pickCoverTime(silent, ranges, 20, 1)).toBe(0.8);
  });
});
