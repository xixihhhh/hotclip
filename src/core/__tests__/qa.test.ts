import { describe, it, expect } from "vitest";
import {
  parseBlackSpans,
  parseSilenceSpans,
  parseLoudnessSummary,
  countMidWordCuts,
  assessClipQa,
  type QaAssessment,
} from "../qa";

// ffmpeg stderr 片段仿真(与真实输出同格式)
const BLACK_LINES = [
  "[blackdetect @ 0x7f8a] black_start:12.04 black_end:12.92 black_duration:0.88",
  "frame=  100 fps= 50 q=-0.0 size=N/A",
  "[blackdetect @ 0x7f8a] black_start:30.5 black_end:31.1 black_duration:0.6",
].join("\n");

const SILENCE_LINES = [
  "[silencedetect @ 0x600] silence_start: 5.2",
  "[silencedetect @ 0x600] silence_end: 8.1 | silence_duration: 2.9",
  "[silencedetect @ 0x600] silence_start: 20.0",
].join("\n");

const EBUR128_SUMMARY = `
[Parsed_ebur128_1 @ 0x600] Summary:

  Integrated loudness:
    I:         -14.2 LUFS
    Threshold: -24.9 LUFS

  Loudness range:
    LRA:         3.4 LU
    Threshold:  -34.6 LUFS
    LRA low:   -16.5 LUFS
    LRA high:  -13.1 LUFS

  True peak:
    Peak:       -1.4 dBFS
`;

describe("parseBlackSpans", () => {
  it("同行 start/end 成对提取", () => {
    expect(parseBlackSpans(BLACK_LINES)).toEqual([
      { startSec: 12.04, endSec: 12.92 },
      { startSec: 30.5, endSec: 31.1 },
    ]);
  });

  it("无匹配返回空数组", () => {
    expect(parseBlackSpans("frame= 10 fps=25")).toEqual([]);
  });
});

describe("parseSilenceSpans", () => {
  it("跨行 start/end 按序配对;收尾未闭合的用流长闭合", () => {
    expect(parseSilenceSpans(SILENCE_LINES, 25)).toEqual([
      { startSec: 5.2, endSec: 8.1 },
      { startSec: 20, endSec: 25 },
    ]);
  });

  it("不传流长时丢弃未闭合的收尾静音", () => {
    expect(parseSilenceSpans(SILENCE_LINES)).toEqual([{ startSec: 5.2, endSec: 8.1 }]);
  });

  it("silence_start 可为负(编码器前置静音),钳到 0", () => {
    const spans = parseSilenceSpans("silence_start: -0.02\nsilence_end: 3.0 | silence_duration: 3.02");
    expect(spans).toEqual([{ startSec: 0, endSec: 3 }]);
  });
});

describe("parseLoudnessSummary", () => {
  it("取末尾汇总的 I 与真峰值", () => {
    expect(parseLoudnessSummary(EBUR128_SUMMARY)).toEqual({ integratedLufs: -14.2, truePeakDb: -1.4 });
  });

  it("有多段输出时取最后一组(汇总在末尾)", () => {
    const doubled = `I: -20.0 LUFS\nPeak: -5.0 dBFS\n${EBUR128_SUMMARY}`;
    expect(parseLoudnessSummary(doubled)).toEqual({ integratedLufs: -14.2, truePeakDb: -1.4 });
  });

  it("缺 I 或 Peak 返回 null", () => {
    expect(parseLoudnessSummary("I: -14.0 LUFS")).toBeNull();
    expect(parseLoudnessSummary("")).toBeNull();
  });
});

describe("countMidWordCuts (切点半词复核)", () => {
  const words = [
    { text: "今天", startSec: 10.0, endSec: 10.5 },
    { text: "直播", startSec: 10.6, endSec: 11.2 },
    { text: "开始", startSec: 11.3, endSec: 12.0 },
  ];

  it("切点压在词中间计数", () => {
    // 起点 10.9 落在「直播」(10.6-11.2)内部
    expect(countMidWordCuts(words, [{ startSec: 10.9, endSec: 12.0 }])).toBe(1);
  });

  it("切点在词边界或词间空隙不计", () => {
    expect(countMidWordCuts(words, [{ startSec: 10.55, endSec: 12.0 }])).toBe(0); // 空隙
    expect(countMidWordCuts(words, [{ startSec: 10.6, endSec: 12.0 }])).toBe(0); // 边界
  });

  it("容差内的压线不计(淡化窗口)", () => {
    // 10.63 距词头 10.6 只有 0.03,在容差内
    expect(countMidWordCuts(words, [{ startSec: 10.63, endSec: 12.0 }])).toBe(0);
  });

  it("跳剪多段:每个内部拼缝的两侧都复核", () => {
    const segs = [
      { startSec: 10.0, endSec: 10.9 }, // 尾切进「直播」
      { startSec: 11.5, endSec: 12.0 }, // 头切进「开始」
    ];
    expect(countMidWordCuts(words, segs)).toBe(2);
  });

  it("无词或无段返回 0", () => {
    expect(countMidWordCuts([], [{ startSec: 0, endSec: 1 }])).toBe(0);
    expect(countMidWordCuts(words, [])).toBe(0);
  });
});

describe("assessClipQa (纯判定)", () => {
  const clean: QaAssessment = {
    durationSec: 30.1,
    expectedDurationSec: 30,
    blackSpans: [],
    silenceSpans: [],
    loudness: { integratedLufs: -14.2, truePeakDb: -1.4 },
    loudnessNormalized: true,
    midWordCuts: 0,
  };

  it("全部通过 → pass 且 issues 为空", () => {
    const r = assessClipQa(clean);
    expect(r.status).toBe("pass");
    expect(r.issues).toEqual([]);
  });

  it("时长偏差超容忍 → 告警", () => {
    const r = assessClipQa({ ...clean, durationSec: 28 });
    expect(r.status).toBe("warn");
    expect(r.issues[0]).toContain("偏差");
  });

  it("黑屏/长静音 → 各自成告警条", () => {
    const r = assessClipQa({
      ...clean,
      blackSpans: [{ startSec: 1, endSec: 2 }],
      silenceSpans: [{ startSec: 5, endSec: 8 }],
    });
    expect(r.issues).toHaveLength(2);
    expect(r.issues[0]).toContain("黑屏");
    expect(r.issues[1]).toContain("静音");
  });

  it("响度偏离与真峰值超限 → 仅在开了响度标准化时核对", () => {
    const off = { integratedLufs: -18, truePeakDb: -0.2 };
    const on = assessClipQa({ ...clean, loudness: off });
    expect(on.issues).toHaveLength(2);
    // 没开响度标准化:实测偏离不算错(源本来就没归一)
    const offNorm = assessClipQa({ ...clean, loudness: off, loudnessNormalized: false });
    expect(offNorm.status).toBe("pass");
  });

  it("半词切点 → 告警;midWordCuts 为 null(没词)不告警", () => {
    expect(assessClipQa({ ...clean, midWordCuts: 2 }).issues[0]).toContain("词中间");
    expect(assessClipQa({ ...clean, midWordCuts: null }).status).toBe("pass");
  });

  it("报告数值做了精度归一(JSON 可读)", () => {
    const r = assessClipQa({ ...clean, blackSpans: [{ startSec: 1.23456, endSec: 2.34567 }] });
    expect(r.blackSpans[0]).toEqual({ startSec: 1.23, endSec: 2.35 });
    expect(r.loudness).toEqual({ integratedLufs: -14.2, truePeakDb: -1.4 });
  });
});
