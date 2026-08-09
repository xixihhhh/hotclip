/**
 * v0.14「发得出去、活得下来」首批:变形度评分/实用密度信号/分发台账 CSV/
 * AIGC 平台文案/发布文案收藏导向。
 */
import { describe, it, expect } from "vitest";
import { transformScore, TRANSFORM_WARN_BELOW, type TransformInputs } from "../../shared/transform-score";
import { utilityDensity, utilityBoost, UTILITY_SAVE_WORTHY } from "../../shared/utility-density";
import { buildLedgerCsv, csvField } from "../ledger";
import { adaptPost } from "../publish-pack";
import { platformSpec } from "../../shared/platform-specs";
import { postTextFile, publishSystemPrompt, publishUserPrompt } from "../publish";
import { transformInputsFromRender } from "../export";
import { applyUtilitySignal } from "../highlight/detect";
import type { HighlightCandidate } from "../../shared/api-types";

const ALL_OFF: TransformInputs = {
  vertical: false, captions: false, recut: false, reopened: false, titleOverlay: false,
  autoZoom: false, bgm: false, sfx: false, stitched: false, translated: false, watermark: false,
};

describe("transformScore(变形度)", () => {
  it("全关 = 0 分 warn(裁一刀直接发),缺失项按权重排序给建议", () => {
    const s = transformScore(ALL_OFF);
    expect(s.score).toBe(0);
    expect(s.level).toBe("warn");
    expect(s.missingTop).toEqual(["vertical", "captions", "recut"]);
  });
  it("出厂默认组合(竖屏+字幕+跳剪+标题贴片)过警戒线", () => {
    const s = transformScore({ ...ALL_OFF, vertical: true, captions: true, recut: true, titleOverlay: true });
    expect(s.score).toBeGreaterThanOrEqual(TRANSFORM_WARN_BELOW);
    expect(s.level).not.toBe("warn");
  });
  it("只开字幕不够(20 分 warn);全开封顶 100 strong", () => {
    expect(transformScore({ ...ALL_OFF, captions: true }).level).toBe("warn");
    const all = Object.fromEntries(Object.keys(ALL_OFF).map((k) => [k, true])) as unknown as TransformInputs;
    const s = transformScore(all);
    expect(s.score).toBe(100);
    expect(s.level).toBe("strong");
    expect(s.missingTop).toEqual([]);
  });
});

describe("transformInputsFromRender(按实际发生映射,回退不骗分)", () => {
  const render = {
    captionStyle: "keyword", captionsBurned: false, reframe: "center-crop" as const,
    edit: null, fillersRemoved: 0, retakesRemoved: 0, stitchedPieces: 0,
    loudnessNormalized: true, denoised: false, coldOpenSec: null, flashForward: false,
    openingHookBurned: false, translatedLines: 0, shotSnap: null, preciseAligned: false,
    sfxCues: 0, bgmMixed: false,
  };
  it("字幕烧录失败(captionsBurned=false)不给字幕分;竖屏按 reframe 算", () => {
    const inputs = transformInputsFromRender(render, {});
    expect(inputs.captions).toBe(false);
    expect(inputs.vertical).toBe(true);
    expect(inputs.recut).toBe(false);
  });
  it("跳剪按 splices/口头禅/重录任一生效", () => {
    expect(transformInputsFromRender({ ...render, fillersRemoved: 2 }, {}).recut).toBe(true);
    expect(transformInputsFromRender({ ...render, edit: { splices: 3, keptSec: 10, removedSec: 2, cutRatio: 0.16 } }, {}).recut).toBe(true);
  });
});

describe("utilityDensity(实用密度)", () => {
  it("步骤+数字+方法论命中给高分;闲聊为 0", () => {
    const dense = utilityDensity("首先把水烧到100度,然后加两勺,最后焖3个技巧里最关键的一步,这个方法省钱200元");
    expect(dense.score).toBeGreaterThanOrEqual(UTILITY_SAVE_WORTHY);
    expect(dense.hits.length).toBeGreaterThan(0);
    expect(utilityDensity("哈哈哈今天天气不错啊兄弟们").score).toBe(0);
  });
  it("加分小幅且封顶(不推翻爆点排序)", () => {
    expect(utilityBoost(0)).toBe(0);
    expect(utilityBoost(10)).toBeLessThanOrEqual(6);
  });
});

describe("applyUtilitySignal(第十路回流)", () => {
  const cand = (over: Partial<HighlightCandidate>): HighlightCandidate => ({
    id: 1, startSec: 0, endSec: 20, text: "", title: "t", hook: "h", score: 80, reason: "r",
    boundary: "exact", keywords: [], recommended: true, reviewNote: "", ...over,
  });
  it("达线加分打标;信号候选与闲聊不动", () => {
    const out = applyUtilitySignal(
      [
        cand({ id: 1, text: "第一步先看成分表,第二步对比100毫升单价,三个技巧记住了" }),
        cand({ id: 2, text: "哈哈哈太好笑了" }),
        cand({ id: 3, boundary: "signal", text: "第一步第二步第三步" }),
      ],
      true
    );
    expect(out[0].utility).toBeDefined();
    expect(out[0].score).toBeGreaterThan(80);
    expect(out[0].reason).toContain("实用密度");
    expect(out[1].utility).toBeUndefined();
    expect(out[2].utility).toBeUndefined();
  });
});

describe("分发台账 CSV", () => {
  it("BOM+表头+转义,发布侧四列留空", () => {
    const csv = buildLedgerCsv([
      {
        file: "a.mp4", title: '标题带,逗号和"引号"', durationSec: 32.18, source: "/v/源.mp4",
        sourceStartSec: 100.123, sourceEndSec: 132.3, pieces: 2, exportedAt: "2026-08-09T12:00:00Z",
        aigcLabel: true, transformScore: 66,
      },
    ]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("成片文件,标题");
    expect(csv).toContain('"标题带,逗号和""引号"""');
    expect(csv).toContain("是,66,,,,");
  });
  it("csvField 只在必要时加引号", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField(null)).toBe("");
  });
});

describe("AIGC 平台文案", () => {
  it("发布包文案开 AIGC 时附平台操作提示", () => {
    const spec = platformSpec("douyin")!;
    const withNote = adaptPost("标题", undefined, spec, true);
    expect(withNote.text).toContain("【AIGC 标注】");
    expect(withNote.text).toContain("内容由AI生成");
    expect(adaptPost("标题", undefined, spec, false).text).not.toContain("AIGC");
  });
  it(".post.txt 开 AIGC 时附通用声明", () => {
    const copy = { title: "t", hashtags: [], description: "d" };
    expect(postTextFile(copy, true)).toContain("AIGC 标注");
    expect(postTextFile(copy)).not.toContain("AIGC");
  });
});

describe("发布文案收藏/搜索导向", () => {
  it("system prompt 带 2026 算法要点;可收藏源打标进 user prompt", () => {
    expect(publishSystemPrompt(true)).toContain("收藏");
    expect(publishSystemPrompt(true)).toContain("搜索");
    expect(publishSystemPrompt(false)).toContain("save-worthy");
    const u = publishUserPrompt([
      { id: 1, title: "t", hook: "h", text: "x", keywords: [], saveWorthy: true },
      { id: 2, title: "t2", hook: "h2", text: "y", keywords: [] },
    ]);
    expect(u).toContain("[1] [可收藏]");
    expect(u).not.toContain("[2] [可收藏]");
  });
});
