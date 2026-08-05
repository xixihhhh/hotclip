/**
 * 信号驱动通道:文字稿没内容时(舞见/萌宠/美食/户外/电台)唯一能出候选的路。
 */
import { describe, it, expect } from "vitest";
import {
  fuseMoments,
  speechRatio,
  shouldRunMoments,
  MOMENT_WEIGHTS,
  MOMENT_SATURATION,
  SPARSE_SPEECH_RATIO,
  topMoments,
} from "../highlight/moments";
import { momentsToCandidates, parseMomentPicks, textInRange } from "../highlight/detect";
import type { MediaSignals } from "../signals";
import type { Transcript } from "../transcribe/types";

const r = (startSec: number, endSec: number): { startSec: number; endSec: number } => ({ startSec, endSec });
const empty: MediaSignals = { loudPeaks: [], cutDense: [] };

/** 只有零散寒暄的转写(典型的跳舞直播)。 */
function sparseTranscript(durationSec = 600): Transcript {
  const segments = [
    { id: 1, startSec: 5, endSec: 8, text: "大家好呀", words: [] },
    { id: 2, startSec: 300, endSec: 303, text: "谢谢老板的礼物", words: [] },
  ];
  return { language: "zh", segments, engine: "test", durationSec };
}

describe("speechRatio", () => {
  it("跳舞直播这种大段没人说话的,占比很低", () => {
    expect(speechRatio(sparseTranscript(600))).toBeCloseTo(6 / 600, 4);
  });

  it("从头说到尾的播客接近 1", () => {
    const tx: Transcript = {
      language: "zh",
      engine: "t",
      durationSec: 100,
      segments: [{ id: 1, startSec: 0, endSec: 95, text: "一直在说", words: [] }],
    };
    expect(speechRatio(tx)).toBeGreaterThan(0.9);
  });

  it("时长为 0 不炸", () => {
    expect(speechRatio({ language: "zh", engine: "t", durationSec: 0, segments: [] })).toBe(0);
  });
});

describe("shouldRunMoments", () => {
  it("反应类/画面类品类一定跑(文字稿本来就不该信)", () => {
    expect(shouldRunMoments("visual", 0.9, 5)).toBe(true);
    expect(shouldRunMoments("reaction", 0.9, 5)).toBe(true);
  });

  it("说话占比过低时,哪怕选的是话痨品类也要跑(素材自己说明了问题)", () => {
    expect(shouldRunMoments("words", SPARSE_SPEECH_RATIO - 0.05, 5)).toBe(true);
  });

  it("文本通道产出太少时兜底跑", () => {
    expect(shouldRunMoments("words", 0.9, 1)).toBe(true);
  });

  it("话痨品类 + 说得多 + 文本通道正常 → 不跑(省一次 LLM 调用)", () => {
    expect(shouldRunMoments("words", 0.9, 4)).toBe(false);
  });
});

describe("fuseMoments", () => {
  it("没有信号时返回空,不编造时刻", () => {
    expect(fuseMoments(undefined, 600, { weights: MOMENT_WEIGHTS.visual, minSec: 10, maxSec: 30 })).toEqual([]);
    expect(fuseMoments(empty, 600, { weights: MOMENT_WEIGHTS.visual, minSec: 10, maxSec: 30 })).toEqual([]);
  });

  it("多路信号重合的位置排在最热", () => {
    const signals: MediaSignals = {
      loudPeaks: [r(100, 110)],
      cutDense: [r(100, 110)],
      visualPeaks: [r(100, 110)],
      danmakuPeaks: [r(100, 110)],
      // 另一处只有一路孤证
      emotionPeaks: [r(400, 410)],
    };
    const out = fuseMoments(signals, 600, { weights: MOMENT_WEIGHTS.visual, minSec: 10, maxSec: 30 });
    expect(out.length).toBeGreaterThanOrEqual(2);
    const hot = [...out].sort((a, b) => b.heat - a.heat)[0];
    expect(hot.startSec).toBeLessThan(120);
    expect(hot.endSec).toBeGreaterThan(100);
    // 证据链要列出参与的信号种类
    expect(hot.evidence).toEqual(expect.arrayContaining(["loud", "cut", "visual", "danmaku"]));
  });

  it("时刻按时间排序并从 1 连续编号(LLM 按编号引用)", () => {
    const signals: MediaSignals = {
      loudPeaks: [r(500, 510)],
      cutDense: [r(100, 110)],
      danmakuPeaks: [r(300, 310)],
    };
    const out = fuseMoments(signals, 600, { weights: MOMENT_WEIGHTS.reaction, minSec: 10, maxSec: 30 });
    expect(out.map((m) => m.id)).toEqual(out.map((_, i) => i + 1));
    for (let i = 1; i < out.length; i++) {
      expect(out[i].startSec).toBeGreaterThanOrEqual(out[i - 1].startSec);
    }
  });

  it("时刻彼此不重叠(同一个高潮不切成好几条)", () => {
    const signals: MediaSignals = {
      loudPeaks: [r(100, 104), r(112, 116), r(124, 128)],
      cutDense: [],
      danmakuPeaks: [r(100, 128)],
    };
    const out = fuseMoments(signals, 600, { weights: MOMENT_WEIGHTS.reaction, minSec: 10, maxSec: 30 });
    for (let i = 1; i < out.length; i++) {
      expect(out[i].startSec).toBeGreaterThanOrEqual(out[i - 1].endSec);
    }
  });

  it("全程都亮的信号被打折——否则曲线压平、峰值退化成随机", () => {
    // danmaku 覆盖全场(远超饱和阈值),loud 只在一处
    const saturated: MediaSignals = {
      loudPeaks: [r(200, 210)],
      cutDense: [],
      danmakuPeaks: [r(0, 600)],
    };
    const out = fuseMoments(saturated, 600, { weights: MOMENT_WEIGHTS.reaction, minSec: 10, maxSec: 30 });
    expect(out.length).toBeGreaterThan(0);
    // 峰值必须落在 loud 那一处,而不是被全场弹幕带跑
    const hot = [...out].sort((a, b) => b.heat - a.heat)[0];
    expect(hot.startSec).toBeLessThanOrEqual(210);
    expect(hot.endSec).toBeGreaterThanOrEqual(200);
    expect(MOMENT_SATURATION).toBeLessThan(1);
  });

  it("窗口长度落在目标片长附近,且不越过素材边界", () => {
    const signals: MediaSignals = { loudPeaks: [r(2, 6)], cutDense: [], danmakuPeaks: [r(2, 6)] };
    const out = fuseMoments(signals, 60, { weights: MOMENT_WEIGHTS.reaction, minSec: 10, maxSec: 30 });
    expect(out).toHaveLength(1);
    expect(out[0].startSec).toBeGreaterThanOrEqual(0);
    expect(out[0].endSec).toBeLessThanOrEqual(60);
    const dur = out[0].endSec - out[0].startSec;
    expect(dur).toBeGreaterThan(8);
    expect(dur).toBeLessThanOrEqual(32);
  });

  it("画面类与反应类权重是反的:同一份信号选出的最热时刻不同", () => {
    const signals: MediaSignals = {
      loudPeaks: [],
      cutDense: [],
      // A 处纯画面,B 处纯语气
      visualPeaks: [r(100, 115)],
      voiceEmotionPeaks: [r(400, 415)],
    };
    const vis = fuseMoments(signals, 600, { weights: MOMENT_WEIGHTS.visual, minSec: 10, maxSec: 30 });
    const rea = fuseMoments(signals, 600, { weights: MOMENT_WEIGHTS.reaction, minSec: 10, maxSec: 30 });
    const hottest = (a: typeof vis): number => [...a].sort((x, y) => y.heat - x.heat)[0].startSec;
    expect(hottest(vis)).toBeLessThan(200); // 画面类选 A
    expect(hottest(rea)).toBeGreaterThan(300); // 反应类选 B
  });
});

describe("momentsToCandidates", () => {
  const tx = sparseTranscript(600);
  const moments = fuseMoments(
    { loudPeaks: [r(100, 110)], cutDense: [], visualPeaks: [r(100, 110)] },
    600,
    { weights: MOMENT_WEIGHTS.visual, minSec: 10, maxSec: 30 }
  );

  it("时间完全来自信号,boundary 标 signal", () => {
    const out = momentsToCandidates(tx, moments, [
      { momentId: 1, title: "副歌这一段", hook: "转身那一下", score: 88, reason: "画面高能+弹幕", keywords: ["卡点"] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].boundary).toBe("signal");
    expect(out[0].startSec).toBe(moments[0].startSec);
    expect(out[0].endSec).toBe(moments[0].endSec);
    expect(out[0].signalEvidence).toEqual(moments[0].evidence);
  });

  it("编号是编的就丢掉——绝不猜时间", () => {
    const out = momentsToCandidates(tx, moments, [
      { momentId: 999, title: "瞎编的", hook: "", score: 90, reason: "", keywords: [] },
    ]);
    expect(out).toEqual([]);
  });

  it("关键词不做「必须在片内出现」的过滤(它描述的是画面,不是台词)", () => {
    const out = momentsToCandidates(tx, moments, [
      { momentId: 1, title: "t", hook: "", score: 80, reason: "", keywords: ["高难度动作"] },
    ]);
    expect(out[0].keywords).toEqual(["高难度动作"]);
  });
});

describe("parseMomentPicks", () => {
  it("解析带围栏的 JSON,score 钳到 0-100", () => {
    const out = parseMomentPicks('```json\n{"clips":[{"momentId":2,"title":"x","score":150}]}\n```');
    expect(out).toHaveLength(1);
    expect(out[0].momentId).toBe(2);
    expect(out[0].score).toBe(100);
  });

  it("没有 momentId 的行丢弃;整体不是 JSON 时抛错", () => {
    expect(parseMomentPicks('{"clips":[{"title":"没编号"},{"momentId":1,"title":"有"}]}')).toHaveLength(1);
    expect(() => parseMomentPicks("我觉得第三段不错")).toThrow();
  });
});

describe("textInRange", () => {
  it("取重叠的整句;跳舞直播这类可能压根没有台词", () => {
    const tx = sparseTranscript(600);
    expect(textInRange(tx, 0, 20)).toBe("大家好呀");
    expect(textInRange(tx, 100, 200)).toBe("");
  });
});

describe("topMoments", () => {
  it("不超上限时原样返回", () => {
    const ms = [
      { id: 1, startSec: 0, endSec: 10, heat: 5, evidence: [] as never[] },
      { id: 2, startSec: 20, endSec: 30, heat: 9, evidence: [] as never[] },
    ];
    expect(topMoments(ms, 8)).toEqual(ms);
  });

  it("超额按热度取前 N,再按时间排回并重新编号", () => {
    const ms = [1, 2, 3, 4, 5].map((i) => ({
      id: i, startSec: i * 100, endSec: i * 100 + 20, heat: i === 2 ? 1 : 10 + i, evidence: [] as never[],
    }));
    const out = topMoments(ms, 3);
    expect(out).toHaveLength(3);
    // 最冷的 id=2 被淘汰
    expect(out.map((m) => m.startSec)).toEqual([300, 400, 500]);
    // 编号必须重排成 1..n —— 提示词里的编号就是它,错位就会选错时刻
    expect(out.map((m) => m.id)).toEqual([1, 2, 3]);
  });
});
