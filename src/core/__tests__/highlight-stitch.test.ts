/**
 * 多片段拼接的检测侧:parts 解析 → 逐段反查 → 规整 → 时长/重叠口径。
 * 「前后打脸」这类爆点必须引用相隔很远的两处内容,靠的就是这条路径。
 */
import { describe, it, expect } from "vitest";
import { resolveSelection, type RawSelection } from "../highlight/match";
import { parseParts, parseSelections, dropOverlaps } from "../highlight/detect";
import { highlightSystemPrompt, buildHighlightPrompt, buildReviewPrompt } from "../highlight/prompt";
import { PIECE_JOINER } from "../../shared/pieces";
import type { Transcript, TranscriptWord } from "../transcribe/types";
import type { HighlightCandidate } from "../../shared/api-types";

/** 逐字 0.2s 的中文转写;句间留 gapSec 好把两段拉开距离。 */
function makeTranscript(sentences: string[], gapSec = 0.5): Transcript {
  let t = 0;
  let id = 0;
  const segments = sentences.map((text) => {
    id++;
    const words: TranscriptWord[] = Array.from(text).map((ch, i) => ({
      text: ch,
      startSec: Number((t + i * 0.2).toFixed(3)),
      endSec: Number((t + (i + 1) * 0.2).toFixed(3)),
    }));
    const seg = { id, startSec: words[0].startSec, endSec: words[words.length - 1].endSec, text, words };
    t = seg.endSec + gapSec;
    return seg;
  });
  return { language: "zh", segments, engine: "test", durationSec: t };
}

/** 前后打脸的典型素材:先立誓,中间一大段无关内容,后面自己打脸。 */
const FLIP = makeTranscript(
  [
    "我今天把话放在这儿,这个价格绝对绝对不会降。",
    "接下来我们聊点别的东西吧朋友们。",
    "这段中间的内容跟前后都没有关系。",
    "行吧那我今天就给大家降到七十九块钱。",
  ],
  30 // 句间隔 30 秒,足够拉开成两段
);

const base = { title: "t", hook: "h", score: 90, reason: "r", keywords: [] };

describe("parseParts", () => {
  it("少于两段视为没写(退回单段定位)", () => {
    expect(parseParts([{ quoteStart: "只有一段" }])).toBeUndefined();
    expect(parseParts(undefined)).toBeUndefined();
    expect(parseParts("不是数组")).toBeUndefined();
  });

  it("解析两段,句 id 缺失时填 -1(下游退回引文反查)", () => {
    const out = parseParts([
      { startSegmentId: 1, endSegmentId: 1, quoteStart: "我今天", quoteEnd: "不会降。" },
      { quoteStart: "行吧那我", quoteEnd: "七十九块钱。" },
    ]);
    expect(out).toHaveLength(2);
    expect(out![0].startSegmentId).toBe(1);
    expect(out![1].startSegmentId).toBe(-1);
  });

  it("剔掉既没引文也没句 id 的空段;剩不足两段就整个不算", () => {
    expect(parseParts([{ quoteStart: "有引文" }, { title: "空的" }])).toBeUndefined();
  });

  it("parseSelections 把 parts 带进 RawSelection", () => {
    const out = parseSelections(
      JSON.stringify({
        clips: [
          {
            title: "打脸", score: 90, startSegmentId: 1, endSegmentId: 4,
            quoteStart: "我今天", quoteEnd: "七十九块钱。",
            parts: [
              { startSegmentId: 1, endSegmentId: 1, quoteStart: "我今天", quoteEnd: "不会降。" },
              { startSegmentId: 4, endSegmentId: 4, quoteStart: "行吧那我", quoteEnd: "七十九块钱。" },
            ],
          },
        ],
      })
    );
    expect(out[0].parts).toHaveLength(2);
  });
});

describe("resolveSelection with parts", () => {
  const sel: RawSelection = {
    ...base,
    startSegmentId: 1, endSegmentId: 4,
    quoteStart: "我今天把话放在这儿", quoteEnd: "七十九块钱。",
    parts: [
      { startSegmentId: 1, endSegmentId: 1, quoteStart: "我今天把话放在这儿", quoteEnd: "绝对不会降。" },
      { startSegmentId: 4, endSegmentId: 4, quoteStart: "行吧那我今天", quoteEnd: "七十九块钱。" },
    ],
  };

  it("两段各自反查,跨度取首尾,段清单按时间序", () => {
    const r = resolveSelection(FLIP, sel);
    expect(r).not.toBeNull();
    expect(r!.pieces).toHaveLength(2);
    expect(r!.startSec).toBeCloseTo(FLIP.segments[0].startSec, 2);
    expect(r!.endSec).toBeCloseTo(FLIP.segments[3].endSec, 2);
    expect(r!.pieces![0].endSec).toBeLessThan(r!.pieces![1].startSec);
  });

  it("展示文本用省略标记连接——评审和用户必须看得出中间跳了", () => {
    const r = resolveSelection(FLIP, sel);
    expect(r!.text).toContain(PIECE_JOINER.trim());
    expect(r!.text).toContain("不会降");
    expect(r!.text).toContain("七十九");
    // 中间那两句无关内容不能混进来
    expect(r!.text).not.toContain("聊点别的");
  });

  it("乱序给的 parts 会被排回时间序(成片不能倒放剧情)", () => {
    const r = resolveSelection(FLIP, { ...sel, parts: [sel.parts![1], sel.parts![0]] });
    expect(r!.pieces![0].startSec).toBeLessThan(r!.pieces![1].startSec);
    expect(r!.text.indexOf("不会降")).toBeLessThan(r!.text.indexOf("七十九"));
  });

  it("有一段反查不到就退回单段(顶层引文仍然管用),不是整条丢掉", () => {
    const r = resolveSelection(FLIP, {
      ...sel,
      parts: [sel.parts![0], { startSegmentId: 9, endSegmentId: 9, quoteStart: "这句根本不存在", quoteEnd: "也不存在" }],
    });
    expect(r).not.toBeNull();
    expect(r!.pieces).toBeUndefined();
    expect(r!.startSec).toBeCloseTo(FLIP.segments[0].startSec, 2);
  });

  it("两段挨得太近会被合并 → 不足两段 → 退回单段", () => {
    const near = makeTranscript(["前面这句话说得很满。", "后面这句立刻就打脸了。"], 0.4);
    const r = resolveSelection(near, {
      ...base,
      startSegmentId: 1, endSegmentId: 2,
      quoteStart: "前面这句", quoteEnd: "打脸了。",
      parts: [
        { startSegmentId: 1, endSegmentId: 1, quoteStart: "前面这句话", quoteEnd: "很满。" },
        { startSegmentId: 2, endSegmentId: 2, quoteStart: "后面这句", quoteEnd: "打脸了。" },
      ],
    });
    expect(r!.pieces).toBeUndefined();
  });

  it("没有 parts 时行为与历史完全一致", () => {
    const r = resolveSelection(FLIP, { ...base, startSegmentId: 1, endSegmentId: 1, quoteStart: "我今天把话", quoteEnd: "不会降。" });
    expect(r!.pieces).toBeUndefined();
    expect(r!.boundary).toBe("anchored");
  });
});

describe("dropOverlaps 的拼接口径", () => {
  const c = (id: number, s: number, e: number, score: number, pieces?: Array<{ startSec: number; endSec: number }>): HighlightCandidate => ({
    id, startSec: s, endSec: e, pieces, text: "", title: "", hook: "", score, reason: "",
    boundary: "exact", keywords: [], recommended: true, reviewNote: "",
  });

  it("拼接片按段比重叠,不会把跨度中间的候选全吃掉", () => {
    const stitch = c(1, 0, 600, 80, [{ startSec: 0, endSec: 15 }, { startSec: 580, endSec: 600 }]);
    const middle = c(2, 200, 220, 70); // 落在跨度里,但不碰任何一段
    const kept = dropOverlaps([stitch, middle]);
    expect(kept).toHaveLength(2);
  });

  it("真压在某一段上的候选照样被去重", () => {
    const stitch = c(1, 0, 600, 80, [{ startSec: 0, endSec: 15 }, { startSec: 580, endSec: 600 }]);
    const clash = c(2, 10, 30, 70); // 与第一段重叠
    expect(dropOverlaps([stitch, clash])).toHaveLength(1);
  });
});

describe("prompt 里的拼接约定", () => {
  const tx = makeTranscript(["第一句。", "第二句。"]);

  it("系统提示词讲清「只在必须对照时才拼」并保留时长锚点", () => {
    const p = highlightSystemPrompt(tx);
    expect(p).toContain("parts");
    expect(p).toContain("时长 8~40 秒"); // 时长档 replace 的锚点,不能被拼接段落挤掉
    expect(p).toContain("不能制造原话里没有的意思");
  });

  it("输出格式说明里给了 parts 的形状,但主示例保持单段", () => {
    const p = buildHighlightPrompt(tx);
    expect(p).toContain('"parts"');
    // OUTPUT_SHAPE 主示例(clips → keywords)里不出现 parts——否则模型会以为每条都该拼
    expect(p.slice(p.indexOf('"clips"'), p.indexOf('"keywords"'))).not.toContain("parts");
  });

  it("复评提示词报的是成片时长并标出拼接段数", () => {
    const prompt = buildReviewPrompt(tx, [
      { id: 1, title: "打脸", startSec: 0, endSec: 600, text: `前${PIECE_JOINER}后`, pieces: [{ startSec: 0, endSec: 10 }, { startSec: 585, endSec: 600 }] },
    ]);
    expect(prompt).toContain("时长25秒"); // 10+15,不是跨度 600
    expect(prompt).toContain("2 段拼接");
  });
});
