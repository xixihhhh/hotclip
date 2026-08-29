import { describe, it, expect } from "vitest";
import {
  planCandidateFrames,
  parseCandidateReview,
  applyCandidateReviews,
  reviewCandidatesVision,
  reviewUserPrompt,
  REVIEW_FRAMES_PER_CANDIDATE,
} from "../highlight/review-vision";
import type { HighlightCandidate } from "../../shared/api-types";

function cand(over: Partial<HighlightCandidate>): HighlightCandidate {
  return {
    id: 1,
    startSec: 100,
    endSec: 130,
    text: "这是一段测试内容",
    title: "测试标题",
    hook: "测试钩子",
    score: 80,
    reason: "原始理由",
    boundary: "exact",
    keywords: [],
    recommended: true,
    reviewNote: "",
    ...over,
  } as HighlightCandidate;
}

describe("planCandidateFrames(候选内抽帧)", () => {
  it("单段均匀铺帧,全部落在候选区间内", () => {
    const times = planCandidateFrames({ startSec: 100, endSec: 130 });
    expect(times).toHaveLength(REVIEW_FRAMES_PER_CANDIDATE);
    for (const t of times) {
      expect(t).toBeGreaterThan(100);
      expect(t).toBeLessThan(130);
    }
  });

  it("拼接片按段时长比例分帧,每段至少一帧且不落进段间空隙", () => {
    const pieces = [
      { startSec: 100, endSec: 124 }, // 24s
      { startSec: 200, endSec: 203 }, // 3s
    ];
    const times = planCandidateFrames({ startSec: 100, endSec: 203, pieces });
    expect(times.length).toBeLessThanOrEqual(REVIEW_FRAMES_PER_CANDIDATE);
    const inPiece = (t: number): boolean => pieces.some((p) => t > p.startSec && t < p.endSec);
    expect(times.every(inPiece)).toBe(true);
    expect(times.some((t) => t > 200)).toBe(true); // 短段也分到了帧
  });
});

describe("parseCandidateReview(复核输出解析)", () => {
  it("合法 JSON(含 think 块与包裹文本)解析成功,visual 夹回 0-10", () => {
    const v = parseCandidateReview('<think>嗯</think>好的:{"visual":12,"scene":"猫跳上键盘","match":false}');
    expect(v).toEqual({ visual: 10, scene: "猫跳上键盘", match: false });
  });
  it("屏显文字只保留短字符串并结构化回流候选", () => {
    const review = parseCandidateReview('{"visual":8,"scene":"价格牌特写","match":true,"visibleText":["¥19.9"," ¥19.9 ","限时"]}')!;
    expect(review.visibleText).toEqual(["¥19.9", "限时"]);
    const { candidates } = applyCandidateReviews([cand({ id: 1 })], new Map([[1, review]]));
    expect(candidates[0].visualEvidence).toEqual({ score: 8, scene: "价格牌特写", match: true, visibleText: ["¥19.9", "限时"] });
    expect(candidates[0].reason).toContain("屏显文字:¥19.9 / 限时");
  });
  it("垃圾输出返回 null", () => {
    expect(parseCandidateReview("画面很精彩")).toBeNull();
    expect(parseCandidateReview('{"scene":"没分数"}')).toBeNull();
  });
});

describe("applyCandidateReviews(复核回流)", () => {
  it("高画面分加分并重排;看点进 reason", () => {
    const a = cand({ id: 1, score: 80 });
    const b = cand({ id: 2, score: 84 });
    const { candidates, stats } = applyCandidateReviews(
      [b, a],
      new Map([[1, { visual: 10, scene: "全场骚动", match: true }]])
    );
    // a: 80 + min(12, (10-7)*4=12) = 92 > 84 → 排到第一
    expect(candidates[0].id).toBe(1);
    expect(candidates[0].score).toBe(92);
    expect(candidates[0].reason).toContain("画面复核 10/10:全场骚动");
    expect(stats).toEqual({ reviewed: 1, boosted: 1, demoted: 0 });
  });

  it("信号候选画面死气降分;普通候选低分只记录不降", () => {
    const sig = cand({ id: 1, score: 70, boundary: "signal" });
    const txt = cand({ id: 2, score: 70, boundary: "exact" });
    const reviews = new Map([
      [1, { visual: 1, scene: "静态空镜", match: true }],
      [2, { visual: 1, scene: "静态口播", match: true }],
    ]);
    const { candidates, stats } = applyCandidateReviews([sig, txt], reviews);
    const outSig = candidates.find((c) => c.id === 1)!;
    const outTxt = candidates.find((c) => c.id === 2)!;
    expect(outSig.score).toBe(64); // 信号候选的立身之本是画面,死气 = 负证据
    expect(outTxt.score).toBe(70); // 文本候选画面平淡正常,不动分
    expect(stats.demoted).toBe(1);
  });

  it("货不对板标警告,分数不动", () => {
    const { candidates } = applyCandidateReviews(
      [cand({ id: 1, score: 75 })],
      new Map([[1, { visual: 5, scene: "画面里没有标题说的东西", match: false }]])
    );
    expect(candidates[0].score).toBe(75);
    expect(candidates[0].reason).toContain("货不对板");
  });
});

describe("reviewCandidatesVision(执行层,注入桩)", () => {
  it("每条候选一次调用;单条失败跳过;结论回流", async () => {
    const calls: string[] = [];
    const result = await reviewCandidatesVision({
      videoPath: "/v.mp4",
      candidates: [cand({ id: 1, score: 80 }), cand({ id: 2, score: 78, startSec: 200, endSec: 230 })],
      config: { baseUrl: "http://x/v1", model: "m" },
      composeSheet: async () => "sheetbase64",
      chat: async (_llm, _sys, user) => {
        calls.push(user);
        // 第二条(标题里带 id 区分不了,按调用序)故意吐垃圾
        if (calls.length === 2) return "垃圾输出";
        return '{"visual":9,"scene":"爆点画面","match":true}';
      },
    });
    expect(calls).toHaveLength(2);
    expect(result).not.toBeNull();
    expect(result!.stats.reviewed).toBe(1);
    expect(result!.candidates.find((c) => c.id === 1)!.score).toBe(88); // 80 + (9-7)*4
    expect(result!.candidates.find((c) => c.id === 2)!.score).toBe(78); // 未复核,原样
  });

  it("全部失败返回 null(调用方沿用原候选)", async () => {
    const result = await reviewCandidatesVision({
      videoPath: "/v.mp4",
      candidates: [cand({ id: 1 })],
      config: { baseUrl: "http://x/v1", model: "m" },
      composeSheet: async () => null,
    });
    expect(result).toBeNull();
  });

  it("用户提示词带上标题/钩子/摘录(match 判定的依据)", () => {
    const p = reviewUserPrompt(cand({ title: "T", hook: "H", text: "X".repeat(300) }));
    expect(p).toContain("T");
    expect(p).toContain("H");
    expect(p.length).toBeLessThan(300); // 摘录截断
  });
});
