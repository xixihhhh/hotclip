/**
 * 全场画面扫描档(v0.13):抽帧预算/画面时刻线挑选/collectVisionSignal 扫描
 * 模式(注入 chat 与拼图,不跑真 ffmpeg/端点)。
 */
import { describe, it, expect } from "vitest";
import {
  scanFrameBudget,
  pickVisualNotes,
  collectVisionSignal,
  SCAN_MAX_FRAMES,
  SCAN_NOTES_MAX,
  VISION_MAX_FRAMES,
} from "../highlight/vision";

describe("scanFrameBudget", () => {
  it("~30 秒一帧,下限一张满格接触表,封顶 270", () => {
    expect(scanFrameBudget(60)).toBe(9); // 短片也至少 9 帧
    expect(scanFrameBudget(3600)).toBe(120); // 1 小时 = 120 帧
    expect(scanFrameBudget(6 * 3600)).toBe(SCAN_MAX_FRAMES); // 超长封顶
    expect(scanFrameBudget(0)).toBe(0);
  });
});

describe("pickVisualNotes", () => {
  it("能量达标才入选,按能量取前 N 后按时间排", () => {
    const scored = [
      { t: 300, energy: 8, note: "翻车瞬间" },
      { t: 100, energy: 9, note: "摔产品" },
      { t: 200, energy: 3, note: "静态口播" }, // 低能量剔除
    ];
    expect(pickVisualNotes(scored)).toEqual([
      { t: 100, energy: 9, note: "摔产品" },
      { t: 300, energy: 8, note: "翻车瞬间" },
    ]);
  });
  it("条数封顶", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ t: i * 10, energy: 7, note: `画面${i}` }));
    expect(pickVisualNotes(many)).toHaveLength(SCAN_NOTES_MAX);
  });
});

describe("collectVisionSignal 扫描档", () => {
  const config = { baseUrl: "http://localhost:11434/v1", model: "qwen3-vl:4b" };
  /** 注入的研判:每格 energy 7 且带描述。 */
  const chat = async (_llm: unknown, _sys: string, user: string): Promise<string> => {
    const n = (user.match(/\d+=/g) ?? []).length;
    const cells = Array.from({ length: n }, (_, i) => `{"i":${i + 1},"energy":7,"note":"画面${i + 1}"}`);
    return `{"cells":[${cells.join(",")}]}`;
  };
  const composeSheet = async (): Promise<string> => "ZmFrZQ=="; // 假 jpeg

  it("扫描档抽帧数按时长扩到快扫之上,并回流画面时刻线", async () => {
    const out = await collectVisionSignal({
      videoPath: "/tmp/fake.mp4",
      durationSec: 3600,
      config,
      scan: true,
      composeSheet,
      chat,
    });
    expect(out).not.toBeNull();
    expect(out!.stats.framesTotal).toBeGreaterThan(VISION_MAX_FRAMES);
    expect(out!.stats.fullScan).toBe(true);
    expect(out!.stats.notedMoments).toBe(out!.visualNotes.length);
    expect(out!.visualNotes.length).toBeGreaterThan(0);
    expect(out!.visualNotes.length).toBeLessThanOrEqual(SCAN_NOTES_MAX);
    // 时刻线按时间升序
    const ts = out!.visualNotes.map((n) => n.t);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });

  it("快扫档(缺省)不回流时刻线,统计不带 fullScan", async () => {
    const out = await collectVisionSignal({
      videoPath: "/tmp/fake.mp4",
      durationSec: 3600,
      config,
      composeSheet,
      chat,
    });
    expect(out).not.toBeNull();
    expect(out!.visualNotes).toEqual([]);
    expect(out!.stats.fullScan).toBeUndefined();
    expect(out!.stats.framesTotal).toBeLessThanOrEqual(VISION_MAX_FRAMES);
  });
});
