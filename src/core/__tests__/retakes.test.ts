import { describe, it, expect } from "vitest";
import {
  normalizeForCompare,
  sentenceSimilarity,
  findRetakes,
  retakeCutSpans,
  dropRetakeWords,
} from "../retakes";
import type { TranscriptWord } from "../../shared/api-types";

/** 把中文句子摊成逐字词流(每字 0.2s),句间留 0.3s(不触发静音切句阈值 0.8s)。 */
function speak(sentences: string[], startSec = 0, charSec = 0.2, gapSec = 0.3): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  let t = startSec;
  for (const s of sentences) {
    for (const ch of s) {
      words.push({ text: ch, startSec: Number(t.toFixed(3)), endSec: Number((t + charSec).toFixed(3)) });
      t += charSec;
    }
    t += gapSec;
  }
  return words;
}

describe("normalizeForCompare", () => {
  it("去标点空白、转小写——标点恢复的差异不该让同一句变两句", () => {
    expect(normalizeForCompare("这款,真的很好用!")).toBe("这款真的很好用");
    expect(normalizeForCompare("Hello, World!")).toBe("helloworld");
  });
});

describe("sentenceSimilarity", () => {
  it("完全相同=1,毫不相干≈0", () => {
    expect(sentenceSimilarity("这款产品真的很好用", "这款产品真的很好用")).toBe(1);
    expect(sentenceSimilarity("这款产品真的很好用", "明天下午三点开会")).toBeLessThan(0.2);
  });

  it("只差标点仍判为同一句", () => {
    expect(sentenceSimilarity("这款产品真的很好用", "这款产品,真的很好用!")).toBe(1);
  });

  it("说到一半重来(前缀重复)分数高", () => {
    expect(sentenceSimilarity("这款产品的核心卖点是", "这款产品的核心卖点是吸水快")).toBeGreaterThan(0.72);
  });

  it("空串不炸", () => {
    expect(sentenceSimilarity("", "有内容")).toBe(0);
    expect(sentenceSimilarity("", "")).toBe(0);
  });
});

describe("findRetakes", () => {
  it("紧挨着说两遍 → 剪掉前一遍,保留最后一遍", () => {
    const words = speak(["这款产品的核心卖点是吸水快。", "这款产品的核心卖点是吸水快。", "我们看下一款。"]);
    const hits = findRetakes(words);
    expect(hits.length).toBe(1);
    expect(hits[0].text).toContain("核心卖点");
    expect(hits[0].similarity).toBeGreaterThanOrEqual(0.72);
    // 剪的是第一遍:结束时间落在第二遍开始之前
    expect(hits[0].endSec).toBeLessThan(words[words.length - 1].startSec);
    expect(hits[0].startSec).toBe(words[0].startSec);
  });

  it("说错三遍 → 前两遍都剪掉,只留最后一遍", () => {
    const line = "今天给大家带来一款好东西。";
    const words = speak([line, line, line]);
    const hits = findRetakes(words);
    expect(hits.length).toBe(2);
    expect(hits[0].startSec).toBeLessThan(hits[1].startSec);
  });

  it("中间夹一句插话仍能配上对(重录常夹「啊不对」)", () => {
    const words = speak(["这款产品的核心卖点是吸水快。", "啊不对等一下。", "这款产品的核心卖点是吸水强。"]);
    const hits = findRetakes(words);
    expect(hits.length).toBe(1);
    expect(hits[0].text).toContain("吸水快");
  });

  it("短句天然重复,不碰(好的/对/来)", () => {
    const words = speak(["好的。", "好的。", "对。", "对。"]);
    expect(findRetakes(words)).toEqual([]);
  });

  it("隔得远的话术循环不动(那是带货话术,不是重录)", () => {
    const line = "三二一,上链接,大家快去抢。";
    // 第二遍在 10 分钟后
    const words = [...speak([line], 0), ...speak([line], 600)];
    expect(findRetakes(words)).toEqual([]);
  });

  it("不相似的连续句一句都不剪", () => {
    const words = speak(["今天我们讲第一个话题。", "明天下午三点开会讨论。", "这个方案要重新设计。"]);
    expect(findRetakes(words)).toEqual([]);
  });

  it("空输入与单句输入安全返回空", () => {
    expect(findRetakes([])).toEqual([]);
    expect(findRetakes(speak(["就说了一句完整的话。"]))).toEqual([]);
  });

  it("阈值可调:调高到 1 只认逐字相同", () => {
    const words = speak(["这款产品的核心卖点是吸水快。", "这款产品的核心卖点是吸水强。"]);
    expect(findRetakes(words).length).toBe(1);
    expect(findRetakes(words, { similarity: 1 })).toEqual([]);
  });
});

describe("retakeCutSpans / dropRetakeWords", () => {
  it("废稿段合并成剪切区间,相邻的并成一段", () => {
    const spans = retakeCutSpans([
      { startSec: 10, endSec: 14, text: "a", keptText: "a", similarity: 1 },
      { startSec: 14.1, endSec: 18, text: "b", keptText: "b", similarity: 1 },
      { startSec: 40, endSec: 44, text: "c", keptText: "c", similarity: 1 },
    ]);
    expect(spans).toEqual([
      { startSec: 10, endSec: 18 },
      { startSec: 40, endSec: 44 },
    ]);
  });

  it("剪掉的内容不再出现在字幕词流里", () => {
    const words = speak(["这款产品的核心卖点是吸水快。", "这款产品的核心卖点是吸水快。"]);
    const hits = findRetakes(words);
    const kept = dropRetakeWords(words, hits);
    expect(kept.length).toBeLessThan(words.length);
    // 保留的词全部落在第二遍(第一遍被剪)
    expect(Math.min(...kept.map((w) => w.startSec))).toBeGreaterThanOrEqual(hits[0].endSec);
  });

  it("没有命中时原样返回", () => {
    const words = speak(["一句普通的话。"]);
    expect(dropRetakeWords(words, [])).toBe(words);
  });
});
