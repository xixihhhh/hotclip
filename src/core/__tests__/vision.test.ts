import { describe, it, expect } from "vitest";
import {
  planFrameTimes,
  parseVisionVerdict,
  visualPeakRanges,
  collectVisionSignal,
  VISION_MAX_FRAMES,
  VISION_MIN_SPACING_SEC,
  type VisionChatFn,
} from "../highlight/vision";
import type { MediaSignals } from "../signals";

describe("planFrameTimes", () => {
  it("无信号时均匀铺满全片且不超上限", () => {
    const times = planFrameTimes(600, undefined);
    expect(times.length).toBe(VISION_MAX_FRAMES);
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(VISION_MIN_SPACING_SEC);
    }
    expect(times[0]).toBeGreaterThanOrEqual(0.5);
    expect(times[times.length - 1]).toBeLessThanOrEqual(599.5);
  });

  it("信号窗口中点优先入选", () => {
    const signals: MediaSignals = {
      loudPeaks: [{ startSec: 100, endSec: 110 }],
      cutDense: [{ startSec: 300, endSec: 320 }],
    };
    const times = planFrameTimes(600, signals);
    expect(times).toContain(105); // loudPeaks 中点
    expect(times).toContain(310); // cutDense 中点
  });

  it("信号中点彼此太近时只保留一个(最小间隔)", () => {
    const signals: MediaSignals = {
      loudPeaks: [{ startSec: 100, endSec: 104 }],
      cutDense: [{ startSec: 101, endSec: 105 }], // 中点 103,与 102 相距 1s
    };
    const times = planFrameTimes(600, signals);
    const near = times.filter((t) => t >= 100 && t <= 105);
    expect(near.length).toBe(1);
  });

  it("短片额度自动缩水,时刻夹在片内", () => {
    const times = planFrameTimes(20, undefined);
    expect(times.length).toBeGreaterThan(0);
    expect(times.length).toBeLessThan(VISION_MAX_FRAMES);
    for (const t of times) {
      expect(t).toBeGreaterThanOrEqual(0.5);
      expect(t).toBeLessThanOrEqual(19.5);
    }
  });

  it("时长无效时返回空", () => {
    expect(planFrameTimes(0, undefined)).toEqual([]);
    expect(planFrameTimes(-5, undefined)).toEqual([]);
  });
});

describe("parseVisionVerdict", () => {
  it("解析标准 JSON 输出", () => {
    expect(parseVisionVerdict('{"energy": 8, "note": "两人激烈争论"}')).toEqual({
      energy: 8,
      note: "两人激烈争论",
    });
  });

  it("剥掉 think 块与包裹文本后仍能解析", () => {
    const content = '<think>这帧看起来…</think>好的,评分如下:{"energy":3,"note":"静态口播"}';
    expect(parseVisionVerdict(content)).toEqual({ energy: 3, note: "静态口播" });
  });

  it("energy 越界被夹回 0-10", () => {
    expect(parseVisionVerdict('{"energy": 99, "note": ""}')?.energy).toBe(10);
    expect(parseVisionVerdict('{"energy": -3, "note": ""}')?.energy).toBe(0);
  });

  it("垃圾输出返回 null", () => {
    expect(parseVisionVerdict("这一帧很精彩")).toBeNull();
    expect(parseVisionVerdict('{"note":"没有分数"}')).toBeNull();
    expect(parseVisionVerdict("")).toBeNull();
  });
});

describe("visualPeakRanges", () => {
  it("高能帧扩成时段并按间隔合并", () => {
    const ranges = visualPeakRanges(
      [
        { t: 100, energy: 8 },
        { t: 106, energy: 9 }, // 与上一段间隔 < merge gap → 并段
        { t: 300, energy: 7 },
        { t: 50, energy: 3 }, // 低于阈值,忽略
      ],
      600
    );
    expect(ranges.length).toBe(2);
    expect(ranges[0].startSec).toBeCloseTo(96.5);
    expect(ranges[0].endSec).toBeCloseTo(109.5);
    expect(ranges[1].startSec).toBeCloseTo(296.5);
  });

  it("时段夹在 [0, duration] 内", () => {
    const ranges = visualPeakRanges([{ t: 1, energy: 9 }, { t: 599, energy: 9 }], 600);
    expect(ranges[0].startSec).toBe(0);
    expect(ranges[ranges.length - 1].endSec).toBe(600);
  });

  it("没有高能帧返回空数组", () => {
    expect(visualPeakRanges([{ t: 10, energy: 2 }], 600)).toEqual([]);
  });
});

describe("collectVisionSignal", () => {
  const config = { baseUrl: "http://localhost:11434/v1", model: "qwen3-vl:4b" };
  const okFrame = async (): Promise<string> => "ZmFrZQ=="; // "fake" 的 base64

  it("正常路径:抽帧研判并圈出高能时段", async () => {
    const chat: VisionChatFn = async (_llm, _sys, _user, _img) => '{"energy": 9, "note": "炸裂"}';
    const outcome = await collectVisionSignal({
      videoPath: "/v.mp4",
      durationSec: 300,
      config,
      extractFrame: okFrame,
      chat,
    });
    expect(outcome).not.toBeNull();
    expect(outcome!.stats.framesScored).toBe(outcome!.stats.framesTotal);
    expect(outcome!.visualPeaks.length).toBeGreaterThan(0);
    expect(outcome!.stats.peakCount).toBe(outcome!.visualPeaks.length);
  });

  it("端点全挂 → fail-open 返回 null", async () => {
    const chat: VisionChatFn = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const outcome = await collectVisionSignal({
      videoPath: "/v.mp4",
      durationSec: 300,
      config,
      extractFrame: okFrame,
      chat,
    });
    expect(outcome).toBeNull();
  });

  it("个别帧失败不影响整体", async () => {
    let n = 0;
    const chat: VisionChatFn = async () => {
      n++;
      if (n % 3 === 0) throw new Error("单帧超时");
      return '{"energy": 2, "note": "口播"}';
    };
    const outcome = await collectVisionSignal({
      videoPath: "/v.mp4",
      durationSec: 300,
      config,
      extractFrame: okFrame,
      chat,
    });
    expect(outcome).not.toBeNull();
    expect(outcome!.stats.framesScored).toBeLessThan(outcome!.stats.framesTotal);
    expect(outcome!.visualPeaks).toEqual([]); // 全是低分,不给假信号
  });

  it("抽帧全失败(如纯音频) → null", async () => {
    const chat: VisionChatFn = async () => '{"energy": 9, "note": ""}';
    const outcome = await collectVisionSignal({
      videoPath: "/audio.mp3",
      durationSec: 300,
      config,
      extractFrame: async () => null,
      chat,
    });
    expect(outcome).toBeNull();
  });

  it("上游取消原样上抛", async () => {
    const ac = new AbortController();
    ac.abort();
    const chat: VisionChatFn = async () => '{"energy": 5, "note": ""}';
    await expect(
      collectVisionSignal({
        videoPath: "/v.mp4",
        durationSec: 300,
        config,
        signal: ac.signal,
        extractFrame: okFrame,
        chat,
      })
    ).rejects.toThrow();
  });

  it("预算耗尽带着已得结果收工(不足最少帧数则 null)", async () => {
    let calls = 0;
    const chat: VisionChatFn = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return '{"energy": 8, "note": ""}';
    };
    const outcome = await collectVisionSignal({
      videoPath: "/v.mp4",
      durationSec: 600,
      config,
      extractFrame: okFrame,
      chat,
      budgetMs: 90, // 只够跑 4-5 帧
    });
    expect(calls).toBeLessThan(VISION_MAX_FRAMES);
    // 是否非 null 取决于时序,但两种结局都必须自洽
    if (outcome) expect(outcome.stats.framesScored).toBeGreaterThanOrEqual(3);
  });
});
