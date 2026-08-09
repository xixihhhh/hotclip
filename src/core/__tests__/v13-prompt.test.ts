/**
 * v0.13 提示词增量:用户点题(briefSection)/主播口令与画面时刻线渲染
 * (renderSignals)/带货三段式(productSection+genre)/复评三档判决(REVIEW)。
 */
import { describe, it, expect } from "vitest";
import { briefSection, renderSignals, productSection, highlightSystemPrompt, buildReviewPrompt, BRIEF_MAX_CHARS } from "../highlight/prompt";
import { genreSection } from "../genre";
import type { Transcript, TranscriptWord } from "../transcribe/types";

function makeTranscript(sentences: string[]): Transcript {
  let t = 0;
  let id = 0;
  const segments = sentences.map((text) => {
    id++;
    const words: TranscriptWord[] = Array.from(text).map((ch, i) => ({
      text: ch,
      startSec: t + i * 0.2,
      endSec: t + (i + 1) * 0.2,
    }));
    const seg = { id, startSec: words[0].startSec, endSec: words[words.length - 1].endSec, text, words };
    t = seg.endSec + 0.5;
    return seg;
  });
  return { language: "zh", segments, engine: "test", durationSec: t };
}

describe("briefSection(用户点题)", () => {
  it("focus/exclude 都注入,且声明优先级与不硬凑", () => {
    const s = briefSection({ focus: "重点找售后翻车", exclude: "不要抽奖和念弹幕" }, true);
    expect(s).toContain("重点找:重点找售后翻车");
    expect(s).toContain("明确排除:不要抽奖和念弹幕");
    expect(s).toContain("不许硬凑".replace("不许硬凑", "绝不硬凑"));
  });
  it("单填一项也成段;都空返回空串", () => {
    expect(briefSection({ focus: "只要讲创业的" }, true)).toContain("重点找");
    expect(briefSection({ focus: "只要讲创业的" }, true)).not.toContain("明确排除");
    expect(briefSection({}, true)).toBe("");
    expect(briefSection(undefined, true)).toBe("");
    expect(briefSection({ focus: "  " }, true)).toBe("");
  });
  it("超长点题截断", () => {
    const s = briefSection({ focus: "长".repeat(BRIEF_MAX_CHARS * 2) }, true);
    expect(s.length).toBeLessThan(BRIEF_MAX_CHARS + 200);
  });
  it("英文版走英文文案", () => {
    const s = briefSection({ exclude: "giveaways" }, false);
    expect(s).toContain("Explicitly exclude: giveaways");
  });
  it("highlightSystemPrompt 尾部挂上点题段", () => {
    const tx = makeTranscript(["第一句。"]);
    const p = highlightSystemPrompt(tx, "standard", [], undefined, undefined, undefined, { focus: "售后部分" });
    expect(p).toContain("【用户点题】");
    expect(p).toContain("售后部分");
  });
});

describe("renderSignals:主播口令与画面时刻线", () => {
  it("口令时刻渲染成最高证据并写明滞后语义(内容在口令之前)", () => {
    const s = renderSignals({ loudPeaks: [], cutDense: [], clipCommandMarks: [754, 1810] }, true);
    expect(s).toContain("主播剪辑口令时刻");
    expect(s).toContain("12:34");
    expect(s).toContain("30:10");
    expect(s).toContain("之前");
  });
  it("画面时刻线带时间戳与描述", () => {
    const s = renderSignals(
      { loudPeaks: [], cutDense: [], visualNotes: [{ t: 65, energy: 9, note: "主播摔了产品" }] },
      true
    );
    expect(s).toContain("全场画面时刻线");
    expect(s).toContain("01:05 主播摔了产品(9/10)");
  });
  it("没有新信号时不渲染对应行", () => {
    const s = renderSignals({ loudPeaks: [{ startSec: 1, endSec: 3 }], cutDense: [] }, true);
    expect(s).not.toContain("口令");
    expect(s).not.toContain("画面时刻线");
  });
});

describe("带货三段式(痛点→演示→价格)", () => {
  it("productSection 给出三段式拼接指引且不许硬拼", () => {
    const s = productSection(["纸巾"], true);
    expect(s).toContain("痛点→演示→价格");
    expect(s).toContain("parts");
    expect(s).toContain("不硬拼");
  });
  it("英文版同款", () => {
    const s = productSection(["tissue"], false);
    expect(s).toContain("pain point → demo → price");
  });
  it("shopping 品类判据也带三段式(没填商品词时也生效)", () => {
    expect(genreSection("shopping", true)).toContain("痛点→演示→价格");
    expect(genreSection("shopping", false)).toContain("pain→demo→price");
  });
});

describe("复评三档(质量门 LLM 层)", () => {
  it("复评指令包含 verdict 三档与输出示例", () => {
    const tx = makeTranscript(["第一句。", "第二句。"]);
    const p = buildReviewPrompt(tx, [
      { id: 1, title: "t", startSec: 0, endSec: 1, text: "第一句。" },
    ]);
    expect(p).toContain("verdict");
    expect(p).toContain('"verdict": "publish"');
  });
});
