import { describe, it, expect } from "vitest";
import {
  stripSenseVoiceTag,
  isHotEmotion,
  isHotEvent,
  planVoiceScanWindows,
  mergeHitWindows,
  collectVoiceEmotionSignal,
  topByDuration,
  VOICE_WINDOW_SEC,
  VOICE_MAX_WINDOWS,
  type VoiceWindowTags,
} from "../voice-emotion";
import type { MediaSignals } from "../signals";

describe("stripSenseVoiceTag", () => {
  it("剥 <|TAG|> 包装并归一大写", () => {
    expect(stripSenseVoiceTag("<|HAPPY|>")).toBe("HAPPY");
    expect(stripSenseVoiceTag("<|Laughter|>")).toBe("LAUGHTER");
  });

  it("空值与非标签输入不炸(模型换版本改格式也能兜住)", () => {
    expect(stripSenseVoiceTag(undefined)).toBe("");
    expect(stripSenseVoiceTag(null)).toBe("");
    expect(stripSenseVoiceTag("")).toBe("");
    expect(stripSenseVoiceTag("happy")).toBe("HAPPY");
  });
});

describe("热标签判定", () => {
  it("只认笑/怒/惊三情绪,中性与低落不算爆点", () => {
    expect(isHotEmotion("<|HAPPY|>")).toBe(true);
    expect(isHotEmotion("<|ANGRY|>")).toBe(true);
    expect(isHotEmotion("<|SURPRISED|>")).toBe(true);
    expect(isHotEmotion("<|NEUTRAL|>")).toBe(false);
    expect(isHotEmotion("<|SAD|>")).toBe(false);
    expect(isHotEmotion(undefined)).toBe(false);
  });

  it("只认笑声/掌声/哭腔,常态语音与 BGM 不算", () => {
    expect(isHotEvent("<|Laughter|>")).toBe(true);
    expect(isHotEvent("<|Applause|>")).toBe(true);
    expect(isHotEvent("<|Cry|>")).toBe(true);
    expect(isHotEvent("<|Speech|>")).toBe(false);
    expect(isHotEvent("<|BGM|>")).toBe(false);
  });
});

describe("planVoiceScanWindows", () => {
  it("无信号时按均匀网格铺满,窗长固定且不越界", () => {
    const windows = planVoiceScanWindows(300, undefined);
    expect(windows.length).toBeGreaterThan(0);
    for (const w of windows) {
      expect(w.startSec).toBeGreaterThanOrEqual(0);
      expect(w.endSec).toBeLessThanOrEqual(300);
      expect(w.endSec - w.startSec).toBeCloseTo(VOICE_WINDOW_SEC, 5);
    }
    // 按时间有序(mergeHitWindows 依赖有序输入)
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].startSec).toBeGreaterThanOrEqual(windows[i - 1].startSec);
    }
  });

  it("有响度峰值时优先扫峰值区(把预算花在最可能有爆点的地方)", () => {
    const signals: MediaSignals = {
      loudPeaks: [{ startSec: 100, endSec: 130 }],
      cutDense: [],
    };
    const windows = planVoiceScanWindows(600, signals);
    const inPeak = windows.filter((w) => w.startSec >= 95 && w.endSec <= 140).length;
    // 峰值区只占全片 5%,但应拿到远多于 5% 的窗
    expect(inPeak).toBeGreaterThan(3);
    expect(inPeak / windows.length).toBeGreaterThan(0.05);
  });

  it("窗数不超上限,极短素材不产生窗", () => {
    expect(planVoiceScanWindows(36000, undefined).length).toBeLessThanOrEqual(VOICE_MAX_WINDOWS);
    expect(planVoiceScanWindows(0.5, undefined)).toEqual([]);
    expect(planVoiceScanWindows(0, undefined)).toEqual([]);
  });
});

describe("mergeHitWindows", () => {
  it("相邻命中窗并成一段,远离的各自成段", () => {
    const merged = mergeHitWindows(
      [
        { startSec: 10, endSec: 16 },
        { startSec: 18, endSec: 24 },
        { startSec: 100, endSec: 106 },
      ],
      4
    );
    expect(merged).toEqual([
      { startSec: 10, endSec: 24 },
      { startSec: 100, endSec: 106 },
    ]);
  });

  it("空输入返回空,不改写入参", () => {
    const input = [{ startSec: 1, endSec: 7 }];
    const out = mergeHitWindows(input);
    expect(mergeHitWindows([])).toEqual([]);
    out[0].endSec = 999;
    expect(input[0].endSec).toBe(7); // 合并结果是新对象,没污染调用方
  });
});

describe("topByDuration", () => {
  it("不超额时原样返回", () => {
    const rs = [{ startSec: 0, endSec: 5 }];
    expect(topByDuration(rs, 12)).toBe(rs);
  });

  it("超额时留最长的,不是最早的(直接截前 N 等于只看片头)", () => {
    const rs = [
      { startSec: 0, endSec: 2 },
      { startSec: 10, endSec: 30 },
      { startSec: 40, endSec: 42 },
      { startSec: 50, endSec: 65 },
    ];
    const top = topByDuration(rs, 2);
    expect(top).toEqual([
      { startSec: 10, endSec: 30 },
      { startSec: 50, endSec: 65 },
    ]);
  });

  it("结果仍按时间排序(下游按时间轴消费)", () => {
    const rs = Array.from({ length: 20 }, (_, i) => ({ startSec: i * 10, endSec: i * 10 + (20 - i) }));
    const top = topByDuration(rs, 5);
    for (let i = 1; i < top.length; i++) expect(top[i].startSec).toBeGreaterThan(top[i - 1].startSec);
  });
});

describe("collectVoiceEmotionSignal", () => {
  const base = { videoPath: "/x.mp4", durationSec: 300, modelsRoot: "/models" };

  /** 按时间段给标签的假打标器。 */
  const tagger = (fn: (startSec: number) => VoiceWindowTags | null) => ({
    tagWindow: async (startSec: number): Promise<VoiceWindowTags | null> => fn(startSec),
  });

  it("把命中窗合成两路时段,并如实统计", async () => {
    const out = await collectVoiceEmotionSignal({
      ...base,
      deps: tagger((t) => {
        if (t >= 100 && t < 130) return { emotion: "HAPPY", event: "Laughter" };
        return { emotion: "NEUTRAL", event: "Speech" };
      }),
    });
    expect(out).not.toBeNull();
    expect(out!.voiceEmotionPeaks.length).toBeGreaterThan(0);
    expect(out!.audioEventPeaks.length).toBeGreaterThan(0);
    expect(out!.voiceEmotionPeaks[0].startSec).toBeGreaterThanOrEqual(95);
    expect(out!.stats.emotionPeakCount).toBe(out!.voiceEmotionPeaks.length);
    expect(out!.stats.windowsScored).toBeGreaterThanOrEqual(3);
  });

  it("全程中性 → 两路都空,但仍算成功扫描", async () => {
    const out = await collectVoiceEmotionSignal({
      ...base,
      deps: tagger(() => ({ emotion: "NEUTRAL", event: "Speech" })),
    });
    expect(out!.voiceEmotionPeaks).toEqual([]);
    expect(out!.audioEventPeaks).toEqual([]);
    expect(out!.stats.windowsScored).toBeGreaterThan(0);
  });

  it("单窗解码失败只跳过该窗,不拖垮整次采集", async () => {
    let calls = 0;
    const out = await collectVoiceEmotionSignal({
      ...base,
      deps: {
        tagWindow: async (): Promise<VoiceWindowTags> => {
          calls++;
          if (calls % 3 === 0) throw new Error("decode failed");
          return { emotion: "HAPPY", event: "Speech" };
        },
      },
    });
    expect(out).not.toBeNull();
    expect(out!.stats.windowsScored).toBeGreaterThan(0);
    expect(out!.stats.windowsScored).toBeLessThan(out!.stats.windowsPlanned);
  });

  it("成功窗太少 → 证据太薄,返回 null 而不是假信号", async () => {
    const out = await collectVoiceEmotionSignal({
      ...base,
      deps: { tagWindow: async (): Promise<null> => null },
    });
    expect(out).toBeNull();
  });

  it("预算耗尽带着已得结果收工(不空手而归)", async () => {
    let n = 0;
    const out = await collectVoiceEmotionSignal({
      ...base,
      budgetMs: 60,
      deps: {
        tagWindow: async (): Promise<VoiceWindowTags> => {
          await new Promise((r) => setTimeout(r, 8));
          // 三窗里一窗激动:有命中但不饱和
          return { emotion: n++ % 3 === 0 ? "HAPPY" : "NEUTRAL", event: "Speech" };
        },
      },
    });
    expect(out).not.toBeNull();
    expect(out!.stats.windowsScored).toBeLessThan(out!.stats.windowsPlanned);
    expect(out!.voiceEmotionPeaks.length).toBeGreaterThan(0);
  });

  it("每一窗都命中 → 该路饱和,整路丢弃而不是标成全片爆点", async () => {
    const out = await collectVoiceEmotionSignal({
      ...base,
      deps: tagger(() => ({ emotion: "HAPPY", event: "Laughter" })),
    });
    expect(out).not.toBeNull();
    expect(out!.stats.emotionSaturated).toBe(true);
    expect(out!.stats.eventSaturated).toBe(true);
    expect(out!.voiceEmotionPeaks).toEqual([]);
    expect(out!.audioEventPeaks).toEqual([]);
  });

  it("脱口秀式高命中(约六成窗有笑声)不算饱和,靠时长筛出最炸的几波", async () => {
    // 实测:6 分钟脱口秀 58 窗里 36 窗命中笑声,旧的 0.6 阈值会把这路整个扔掉
    let n = 0;
    const out = await collectVoiceEmotionSignal({
      ...base,
      deps: {
        tagWindow: async (): Promise<VoiceWindowTags> => ({
          emotion: "NEUTRAL",
          event: n++ % 5 < 3 ? "Laughter" : "Speech", // 60% 命中
        }),
      },
    });
    expect(out!.stats.eventSaturated).toBe(false);
    expect(out!.audioEventPeaks.length).toBeGreaterThan(0);
    expect(out!.audioEventPeaks.length).toBeLessThanOrEqual(12);
  });

  it("命中率适中(约三成)时不算饱和,正常出信号", async () => {
    let n = 0;
    const out = await collectVoiceEmotionSignal({
      ...base,
      deps: {
        tagWindow: async (): Promise<VoiceWindowTags> => ({
          emotion: n++ % 3 === 0 ? "ANGRY" : "NEUTRAL",
          event: "Speech",
        }),
      },
    });
    expect(out!.stats.emotionSaturated).toBe(false);
    expect(out!.voiceEmotionPeaks.length).toBeGreaterThan(0);
  });

  it("极短素材没有扫描窗 → null", async () => {
    const out = await collectVoiceEmotionSignal({
      ...base,
      durationSec: 0.5,
      deps: tagger(() => ({ emotion: "HAPPY", event: "Laughter" })),
    });
    expect(out).toBeNull();
  });
});
