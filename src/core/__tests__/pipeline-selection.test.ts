import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoClipConfig } from "../pipeline";
import type { Transcript } from "../../shared/api-types";

vi.mock("../probe", () => ({ probeMedia: vi.fn(async () => ({ hasVideo: false })) }));
vi.mock("../media-evidence", () => ({
  collectSignalsEvidence: vi.fn(async () => undefined), detectShotBoundariesEvidence: vi.fn(),
}));
vi.mock("../emotion", () => ({ collectEmotionSignal: vi.fn(async () => null) }));
vi.mock("../voice-emotion", () => ({ collectVoiceEmotionSignal: vi.fn(async () => null) }));
vi.mock("../danmaku", () => ({ collectDanmakuSignal: vi.fn(async () => null) }));
vi.mock("../subtitle-import", () => ({ importSubtitleFile: vi.fn() }));
vi.mock("../export", () => ({ exportClips: vi.fn(async () => []), sanitizeFilename: (s: string) => s }));

import { autoClip, detectForPipeline, validateDetectionOptions } from "../pipeline";
import { importSubtitleFile } from "../subtitle-import";
import { exportClips } from "../export";
import { collectSignalsEvidence } from "../media-evidence";
import { clipLengthBounds } from "../highlight/detect";
import { highlightSystemPrompt } from "../highlight/prompt";
import { genrePauseGapSec } from "../genre";
import { detectionOptionsFromPrefs } from "../../shared/detection-options";

const transcript: Transcript = {
  engine: "test", language: "zh", durationSec: 1300,
  segments: Array.from({ length: 12 }, (_, i) => {
    const text = `第${i + 1}个产品的独立测评从吸水测试到价格揭晓全部讲清楚。`;
    return { id: i + 1, startSec: i * 100, endSec: i * 100 + 90, text, words: [] };
  }),
};
const config: AutoClipConfig = {
  modelsRoot: "/unused", cacheDir: "/unused", outDir: "/unused/output", subtitlePath: "/unused/source.srt",
  llm: { baseUrl: "http://localhost:11434/v1", model: "test", apiKey: "test" },
};
let requests: Array<{ messages: Array<{ content: string }> }>;
let rejectedThrough = 0;

beforeEach(() => {
  vi.clearAllMocks();
  requests = [];
  rejectedThrough = 0;
  vi.mocked(importSubtitleFile).mockResolvedValue(transcript);
  vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    requests.push(request);
    const first = requests.length === 1;
    const moment = request.messages[1].content.includes("【高能时刻清单】");
    const content = moment ? { clips: [] } : first ? { clips: transcript.segments.map((s) => ({
      title: `产品${s.id}`, hook: s.text, quoteStart: s.text, quoteEnd: s.text,
      startSegmentId: s.id, endSegmentId: s.id, score: 90, reason: "完整演示", keywords: [],
    })) } : { reviews: transcript.segments.map((s) => ({
      id: s.id, keep: s.id > rejectedThrough, gate: s.id > rejectedThrough ? "publish" : "drop", hook: 90, flow: 90, value: 90, trend: 90, note: "完整",
    })) };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }] }));
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("selection controls reach actual detection and export", () => {
  it("keeps the publishable late clips instead of filling the count with rejected early clips", async () => {
    rejectedThrough = 10;
    const result = await autoClip("/source.mp4", { ...config, clipLength: "extended", maxClips: 2 });
    expect(result.candidates.map((c) => c.id)).toEqual([11, 12]);
    expect(vi.mocked(exportClips).mock.calls[0][1]).toHaveLength(2);
  });
  it("asks for ten 1–2 minute clips, caps an overproducing model, and exports with game pacing", async () => {
    const result = await autoClip("/source.mp4", { ...config, clipLength: "extended", maxClips: 10, genre: { id: "game", custom: "只选完整的翻盘过程" } });
    expect(requests[0].messages[0].content).toContain("时长 60~120 秒");
    expect(requests[0].messages[0].content).not.toContain("2~8 句");
    expect(requests[0].messages[0].content).toContain("只选完整的翻盘过程");
    expect(requests[0].messages[0].content).not.toContain("本场是游戏直播");
    expect(requests[0].messages[1].content).toContain("最多 10 个");
    expect(result.candidates).toHaveLength(10);
    expect(result.candidates.every((c) => c.endSec - c.startSec === 90)).toBe(true);
    const exported = vi.mocked(exportClips).mock.calls[0];
    expect(exported[1]).toHaveLength(10);
    expect(exported[3]).toMatchObject({ genreId: "game", jumpCut: true });
    expect(genrePauseGapSec(exported[3]?.genreId)).toBe(0.45);
  });

  it("keeps the default general prompt, six-candidate ceiling and default export rhythm", async () => {
    // Shorten the fixture so the unchanged standard duration accepts it.
    const short = { ...transcript, segments: transcript.segments.map((s) => ({ ...s, endSec: s.startSec + 20 })) };
    vi.mocked(importSubtitleFile).mockResolvedValue(short);
    const result = await autoClip("/source.mp4", config);
    expect(requests[0].messages[0].content).toContain("时长 8~40 秒");
    expect(requests[0].messages[0].content).not.toContain("【本场类型与判据】");
    expect(requests[0].messages[1].content).toContain("最多 6 个");
    expect(result.candidates).toHaveLength(6);
    expect(vi.mocked(exportClips).mock.calls[0][3]?.genreId).toBeUndefined();
  });

  it("activates the reaction channel for a game stream with a dense transcript", async () => {
    vi.mocked(collectSignalsEvidence).mockResolvedValueOnce({ loudPeaks: [{ startSec: 35, endSec: 40 }], cutDense: [], danmakuPeaks: [{ startSec: 35, endSec: 40 }] });
    await detectForPipeline("/source.mp4", transcript, { ...config, genre: { id: "game" }, clipLength: "extended", maxClips: 10 });
    expect(requests).toHaveLength(3); // text nomination, signal nomination, review
    expect(requests[0].messages[0].content).toContain("本场是游戏直播");
    expect(requests[1].messages[1].content).toContain("最多 10 个");
  });

  it("rejects invalid parameters before ASR, and migrates legacy watch preferences", async () => {
    await expect(autoClip("/source.mp4", { ...config, genre: { id: "typo" } })).rejects.toThrow(/auto.*game/);
    expect(importSubtitleFile).not.toHaveBeenCalled();
    expect(() => validateDetectionOptions({ clipLength: "toString" })).toThrow(/clipLength/);
    expect(() => validateDetectionOptions({ genre: { custom: 5 } })).toThrow(/string/);
    expect(validateDetectionOptions({ maxClips: NaN }).maxClips).toBe(6);
    expect(detectionOptionsFromPrefs({ clipLength: "extended", maxClips: 10, genreId: "gaming", genreCustom: "" }).genre?.id).toBe("game");
  });

  it("uses exact source-duration bounds for the explicit 1–2 minute preset in both languages", () => {
    expect(clipLengthBounds("extended")).toEqual({ lo: 60, hi: 120 });
    const en = highlightSystemPrompt({ ...transcript, language: "en" }, "extended");
    expect(en).toContain("Length 60–120 seconds");
    expect(en).not.toContain("2–8 transcript sentences");
  });
});
