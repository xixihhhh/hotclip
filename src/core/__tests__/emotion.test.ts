import { describe, it, expect } from "vitest";
import {
  planEmotionFrameTimes,
  grayFaceTensor,
  softmax,
  emotionPeakScore,
  collectEmotionSignal,
  EMOTION_MAX_FRAMES,
  EMOTION_MIN_SPACING_SEC,
  FER_INPUT,
  type EmotionDeps,
} from "../emotion";
import type { MediaSignals } from "../signals";
import type { FaceBox } from "../reframe/yunet";

describe("planEmotionFrameTimes", () => {
  it("无信号时均匀铺满,间隔与上限成立", () => {
    const times = planEmotionFrameTimes(3600, undefined);
    expect(times.length).toBe(EMOTION_MAX_FRAMES);
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(EMOTION_MIN_SPACING_SEC);
    }
  });

  it("信号窗口内 2s 步进采样(比全片均匀更密)", () => {
    const signals: MediaSignals = {
      loudPeaks: [{ startSec: 100, endSec: 110 }],
      cutDense: [],
    };
    const times = planEmotionFrameTimes(3600, signals);
    const inWindow = times.filter((t) => t >= 100 && t <= 110);
    expect(inWindow.length).toBeGreaterThanOrEqual(3); // 10s 窗口 / 3s 间隔
  });

  it("时长无效返回空", () => {
    expect(planEmotionFrameTimes(0.5, undefined)).toEqual([]);
  });
});

describe("grayFaceTensor", () => {
  const SIZE = 64; // 用小帧测试(inputSize 参数化)

  function frame(fill: [number, number, number]): Uint8Array {
    const buf = new Uint8Array(SIZE * SIZE * 3);
    for (let i = 0; i < SIZE * SIZE; i++) {
      buf[i * 3] = fill[0];
      buf[i * 3 + 1] = fill[1];
      buf[i * 3 + 2] = fill[2];
    }
    return buf;
  }

  it("输出 64×64,纯白帧≈255,纯黑帧≈0", () => {
    const box: FaceBox = { x: 16, y: 16, w: 32, h: 32, score: 0.9 };
    const white = grayFaceTensor(frame([255, 255, 255]), SIZE, box);
    expect(white.length).toBe(FER_INPUT * FER_INPUT);
    expect(white[FER_INPUT * 32 + 32]).toBeCloseTo(255, 0);
    const black = grayFaceTensor(frame([0, 0, 0]), SIZE, box);
    expect(black[FER_INPUT * 32 + 32]).toBe(0);
  });

  it("BT.601 灰度权重:绿色比蓝色亮", () => {
    const box: FaceBox = { x: 16, y: 16, w: 32, h: 32, score: 0.9 };
    // BGR 帧:纯绿 vs 纯蓝
    const green = grayFaceTensor(frame([0, 255, 0]), SIZE, box)[2080];
    const blue = grayFaceTensor(frame([255, 0, 0]), SIZE, box)[2080];
    expect(green).toBeGreaterThan(blue);
    expect(green).toBeCloseTo(0.587 * 255, 0);
    expect(blue).toBeCloseTo(0.114 * 255, 0);
  });

  it("脸框贴边时外扩不越界(不抛错,值有限)", () => {
    const box: FaceBox = { x: 0, y: 0, w: 20, h: 20, score: 0.9 };
    const out = grayFaceTensor(frame([128, 128, 128]), SIZE, box);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });
});

describe("softmax / emotionPeakScore", () => {
  it("softmax 归一且保序", () => {
    const p = softmax([1, 3, 2]);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(p[1]).toBeGreaterThan(p[2]);
    expect(p[2]).toBeGreaterThan(p[0]);
  });

  it("大数值不溢出", () => {
    const p = softmax([1000, 999]);
    expect(p[0]).toBeGreaterThan(p[1]);
    expect(Number.isFinite(p[0])).toBe(true);
  });

  it("峰值分取笑/惊/怒最大值,忽略中性/悲伤", () => {
    //           中性  开心 惊讶 悲伤 愤怒 厌恶 恐惧 轻蔑
    expect(emotionPeakScore([0.9, 0.05, 0.02, 0, 0.03, 0, 0, 0])).toBeCloseTo(0.05);
    expect(emotionPeakScore([0.1, 0.2, 0.6, 0, 0.1, 0, 0, 0])).toBeCloseTo(0.6);
    expect(emotionPeakScore([0, 0, 0, 1, 0, 0, 0, 0])).toBe(0); // 纯悲伤不算爆点
  });
});

describe("collectEmotionSignal", () => {
  const okFrame = new Uint8Array(640 * 640 * 3);
  const face: FaceBox = { x: 200, y: 200, w: 100, h: 100, score: 0.9 };

  function deps(overrides: Partial<EmotionDeps> = {}): EmotionDeps {
    return {
      extractFrame: async () => okFrame,
      detectFaces: async () => [face],
      scoreEmotion: async () => [0.1, 0.8, 0.05, 0, 0.05, 0, 0, 0], // 开心 0.8
      ...overrides,
    };
  }

  it("正常路径:人脸+高兴 → 圈出表情峰值时段", async () => {
    const outcome = await collectEmotionSignal({
      videoPath: "/v.mp4",
      durationSec: 300,
      modelsRoot: "/tmp/x",
      deps: deps(),
    });
    expect(outcome).not.toBeNull();
    expect(outcome!.stats.facesScored).toBe(outcome!.stats.framesTotal);
    expect(outcome!.emotionPeaks.length).toBeGreaterThan(0);
    expect(outcome!.stats.peakCount).toBe(outcome!.emotionPeaks.length);
  });

  it("全程无人脸(风景/游戏素材) → null", async () => {
    const outcome = await collectEmotionSignal({
      videoPath: "/v.mp4",
      durationSec: 300,
      modelsRoot: "/tmp/x",
      deps: deps({ detectFaces: async () => [] }),
    });
    expect(outcome).toBeNull();
  });

  it("全是中性表情 → 有统计但零峰值(不给假信号)", async () => {
    const outcome = await collectEmotionSignal({
      videoPath: "/v.mp4",
      durationSec: 300,
      modelsRoot: "/tmp/x",
      deps: deps({ scoreEmotion: async () => [0.95, 0.02, 0.01, 0, 0.02, 0, 0, 0] }),
    });
    expect(outcome).not.toBeNull();
    expect(outcome!.emotionPeaks).toEqual([]);
  });

  it("抽帧全失败 → null", async () => {
    const outcome = await collectEmotionSignal({
      videoPath: "/v.mp4",
      durationSec: 300,
      modelsRoot: "/tmp/x",
      deps: deps({ extractFrame: async () => null }),
    });
    expect(outcome).toBeNull();
  });

  it("单帧推理失败跳过,不影响整体", async () => {
    let n = 0;
    const outcome = await collectEmotionSignal({
      videoPath: "/v.mp4",
      durationSec: 300,
      modelsRoot: "/tmp/x",
      deps: deps({
        scoreEmotion: async () => {
          if (++n % 4 === 0) throw new Error("单帧失败");
          return [0.2, 0.7, 0.05, 0, 0.05, 0, 0, 0];
        },
      }),
    });
    expect(outcome).not.toBeNull();
    expect(outcome!.stats.facesScored).toBeLessThan(outcome!.stats.framesTotal);
  });

  it("预算耗尽带着已得结果收工", async () => {
    let calls = 0;
    const outcome = await collectEmotionSignal({
      videoPath: "/v.mp4",
      durationSec: 3600,
      modelsRoot: "/tmp/x",
      budgetMs: 80,
      deps: deps({
        extractFrame: async () => {
          calls++;
          await new Promise((r) => setTimeout(r, 15));
          return okFrame;
        },
      }),
    });
    expect(calls).toBeLessThan(EMOTION_MAX_FRAMES);
    if (outcome) expect(outcome.stats.facesScored).toBeGreaterThanOrEqual(3);
  });
});
