import { describe, it, expect } from "vitest";
import {
  sliceWords,
  groupWordsIntoLines,
  toAssTime,
  buildKaraokeAss,
  buildCaptionAss,
  keywordText,
  popText,
  mergeKeywordWords,
  wrapTitle,
  VERTICAL_LAYOUT,
  HORIZONTAL_LAYOUT,
} from "../subtitle";
import type { Transcript, TranscriptWord } from "../../shared/api-types";

function w(text: string, startSec: number, endSec: number): TranscriptWord {
  return { text, startSec, endSec };
}

const TRANSCRIPT: Transcript = {
  language: "zh",
  engine: "test",
  durationSec: 30,
  segments: [
    { id: 1, startSec: 0, endSec: 4, text: "你好世界", words: [w("你", 0, 1), w("好", 1, 2), w("世", 2, 3), w("界", 3, 4)] },
    { id: 2, startSec: 5, endSec: 8, text: "第二句话", words: [w("第", 5, 6), w("二", 6, 7), w("句", 7, 7.5), w("话", 7.5, 8)] },
  ],
};

describe("sliceWords", () => {
  it("returns only words whose midpoint falls inside the clip", () => {
    const words = sliceWords(TRANSCRIPT, 1, 6);
    expect(words.map((x) => x.text).join("")).toBe("好世界第");
  });

  it("skips whole segments outside the range", () => {
    expect(sliceWords(TRANSCRIPT, 10, 20)).toEqual([]);
  });

  it("preserves per-word speaker labels for end-to-end caption coloring", () => {
    const labeled: Transcript = {
      ...TRANSCRIPT,
      segments: [
        { ...TRANSCRIPT.segments[0], words: TRANSCRIPT.segments[0].words.map((x) => ({ ...x, speaker: 0 })) },
        { ...TRANSCRIPT.segments[1], words: TRANSCRIPT.segments[1].words.map((x) => ({ ...x, speaker: 1 })) },
      ],
    };
    const words = sliceWords(labeled, 1, 6);
    expect(words.find((x) => x.text === "好")?.speaker).toBe(0);
    expect(words.find((x) => x.text === "第")?.speaker).toBe(1);
  });
});

describe("groupWordsIntoLines", () => {
  it("breaks on the width cap (CJK counts double)", () => {
    // 6 CJK chars = 12 units; cap 8 → lines of 4 units = 2 chars
    const words = Array.from("一二三四五六").map((ch, i) => w(ch, i, i + 1));
    const lines = groupWordsIntoLines(words, 4);
    expect(lines.map((l) => l.map((x) => x.text).join(""))).toEqual(["一二", "三四", "五六"]);
  });

  it("breaks on silence gaps > 0.8s", () => {
    const words = [w("a", 0, 0.5), w("b", 0.6, 1), w("c", 2.5, 3)];
    const lines = groupWordsIntoLines(words, 100);
    expect(lines).toHaveLength(2);
    expect(lines[1][0].text).toBe("c");
  });

  it("breaks after a clause-boundary comma once the line is substantial", () => {
    // cap 12 → soft-break allowed at ≥6 units; "友，" ends a clause at 6 units
    const words = Array.from("很多朋友").map((ch, i) => w(ch, i, i + 1));
    words[3].text = "友，"; // punctuation attaches to the preceding word
    const tail = Array.from("这个东西").map((ch, i) => w(ch, i + 4, i + 5));
    const lines = groupWordsIntoLines([...words, ...tail], 12);
    expect(lines[0].map((x) => x.text).join("")).toBe("很多朋友，");
    expect(lines[1][0].text).toBe("这");
  });

  it("keeps a short clause on one line instead of fragmenting on an early comma", () => {
    // "好，" reaches only 4 units < half of cap 12 → no soft break yet
    const words = [w("你", 0, 1), { ...w("好，", 1, 2) }, w("世", 2, 3), w("界", 3, 4)];
    const lines = groupWordsIntoLines(words, 12);
    expect(lines).toHaveLength(1);
    expect(lines[0].map((x) => x.text).join("")).toBe("你好，世界");
  });

  it("backs a width overflow up to the nearest particle so phrases stay intact", () => {
    // cap 10 → "十几块的" (8 units) fits; adding "到" overflows. Break after 的,
    // carry "到" to the next line so "到底" is not split as "…到 / 底…".
    const words = Array.from("十几块的到底").map((ch, i) => w(ch, i, i + 1));
    const lines = groupWordsIntoLines(words, 10);
    expect(lines[0].map((x) => x.text).join("")).toBe("十几块的");
    expect(lines[1].map((x) => x.text).join("")).toBe("到底");
  });

  it("falls back to a width cut when the overflowing run has no particle", () => {
    const words = Array.from("测一测").map((ch, i) => w(ch, i, i + 1));
    const lines = groupWordsIntoLines(words, 4); // cap 4 → 2 chars/line, no particle
    expect(lines.map((l) => l.map((x) => x.text).join(""))).toEqual(["测一", "测"]);
  });
});

describe("toAssTime", () => {
  it("formats H:MM:SS.CC and clamps negatives to zero", () => {
    expect(toAssTime(0)).toBe("0:00:00.00");
    expect(toAssTime(62.345)).toBe("0:01:02.35"); // rounds to centiseconds
    expect(toAssTime(3600 + 61.5)).toBe("1:01:01.50");
    expect(toAssTime(-3)).toBe("0:00:00.00");
  });
});

describe("buildKaraokeAss", () => {
  const words = [w("你", 10, 10.5), w("好", 10.5, 11), w("hello", 11, 11.8), w("world", 12, 12.6)];

  it("emits a vertical PlayRes header and one dialogue per line", () => {
    const ass = buildKaraokeAss(words, 10, VERTICAL_LAYOUT, "PingFang SC");
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
    expect(ass).toContain("Style: Caption,PingFang SC,");
    expect(ass.match(/^Dialogue:/gm)).toHaveLength(1);
  });

  it("shifts timestamps to clip-relative and sweeps \\k through inter-word gaps", () => {
    const ass = buildKaraokeAss(words, 10, HORIZONTAL_LAYOUT, "Arial");
    // line spans 10..12.6 abs → 0:00:00.00..0:00:02.60 rel
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:02.60,Caption");
    // "hello" sweeps until "world" STARTS (12) not until it ends itself (11.8) → 100cs
    expect(ass).toContain("{\\k100}hello ");
    // last word sweeps its own duration → 60cs, and latin↔latin got a space before it
    expect(ass).toContain("{\\k60}world");
  });

  it("joins CJK bare and strips ASS-hostile characters", () => {
    const hostile = [w("你{好}", 0, 1), w("世\\界", 1, 2)];
    const ass = buildKaraokeAss(hostile, 0, HORIZONTAL_LAYOUT, "Arial");
    expect(ass).toContain("{\\k100}你好{\\k100}世界");
  });

  it("holds a line until the next begins so continuous speech never flickers", () => {
    // two width-split lines with a 0.3s gap (1.0→1.3): line 1 must end at 1.30,
    // not at its last word (1.0), so no blank frame flashes between them.
    const words = [w("一", 0, 0.5), w("二", 0.5, 1.0), w("三", 1.3, 1.8), w("四", 1.8, 2.3)];
    const ass = buildCaptionAss(words, 0, { ...VERTICAL_LAYOUT, maxLineUnits: 4 }, "karaoke");
    expect(ass.match(/^Dialogue:/gm)).toHaveLength(2);
    // line 1 ends at line 2's start (1.30), bridging the 0.3s gap
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:01.30,Caption");
  });

  it("clears the caption across a real pause instead of holding stale text", () => {
    // 1.5s gap (>0.8 cap): line 1 holds only +0.8 (ends 1.80), then blank until line 2
    const words = [w("一", 0, 0.5), w("二", 0.5, 1.0), w("三", 2.5, 3.0), w("四", 3.0, 3.5)];
    const ass = buildCaptionAss(words, 0, { ...VERTICAL_LAYOUT, maxLineUnits: 4 }, "karaoke");
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:01.80,Caption");
  });
});

describe("keywordText", () => {
  it("tints the words a keyword covers and restores base color after", () => {
    const line = [w("倒", 0, 1), w("半", 1, 2), w("杯", 2, 3), w("水", 3, 4), w("了", 4, 5)];
    const text = keywordText(line, ["半杯水"]);
    expect(text).toBe("倒{\\c&H0D6EFF&\\fscx108\\fscy108}半杯水{\\c&HFFFFFF&\\fscx100\\fscy100}了");
  });

  it("matches latin keywords case-insensitively across spaced words", () => {
    const line = [w("this", 0, 1), w("Amazing", 1, 2), w("deal", 2, 3)];
    const text = keywordText(line, ["amazing deal"]);
    expect(text).toContain("this {\\c&H0D6EFF&\\fscx108\\fscy108}Amazing deal");
  });

  it("no keywords → plain text", () => {
    const line = [w("你", 0, 1), w("好", 1, 2)];
    expect(keywordText(line, [])).toBe("你好");
  });
});

describe("groupWordsIntoLines punctuation breaks", () => {
  it("starts a new line after sentence-final punctuation", () => {
    const words = [w("你好。", 0, 1), w("再", 1, 2), w("见", 2, 3)];
    const lines = groupWordsIntoLines(words, 100);
    expect(lines.map((l) => l.map((x) => x.text).join(""))).toEqual(["你好。", "再见"]);
  });
});

describe("mergeKeywordWords", () => {
  it("fuses a keyword run into one unbreakable word (timestamps preserved)", () => {
    const words = ["超", "级", "好", "用", "的"].map((ch, i) => w(ch, i, i + 1));
    const merged = mergeKeywordWords(words, ["超级好用"]);
    expect(merged.map((x) => x.text)).toEqual(["超级好用", "的"]);
    expect(merged[0].startSec).toBe(0);
    expect(merged[0].endSec).toBe(4);
  });

  it("keyword can no longer be split across lines", () => {
    const words = "一款超级好用的纸巾".split("").map((ch, i) => w(ch, i, i + 1));
    const merged = mergeKeywordWords(words, ["超级好用"]);
    // cap that would previously split inside 超级好用 (2 units per CJK char)
    const lines = groupWordsIntoLines(merged, 6);
    const joined = lines.map((l) => l.map((x) => x.text).join(""));
    expect(joined.some((l) => l.includes("超级好用"))).toBe(true);
  });
});

describe("title card", () => {
  it("wraps long titles onto two lines by width units", () => {
    expect(wrapTitle("短标题")).toBe("短标题");
    const wrapped = wrapTitle("这是一个特别特别长的爆款标题要换行");
    expect(wrapped).toContain("\\N");
    expect(wrapped.split("\\N")).toHaveLength(2);
  });

  it("emits a full-duration Title dialogue on layer 1", () => {
    const words = [w("你", 0, 1)];
    const ass = buildCaptionAss(words, 0, VERTICAL_LAYOUT, "karaoke", {
      titleCard: { text: "半杯水都不渗?", durationSec: 12.5 },
    });
    expect(ass).toContain("Style: Title,");
    expect(ass).toContain("Dialogue: 1,0:00:00.00,0:00:12.50,Title,,0,0,0,,半杯水都不渗?");
  });

  it("title-only ASS works with zero caption words", () => {
    const ass = buildCaptionAss([], 0, VERTICAL_LAYOUT, "karaoke", {
      titleCard: { text: "标题", durationSec: 5 },
    });
    expect(ass.match(/^Dialogue:/gm)).toHaveLength(1);
  });
});

describe("opening hook", () => {
  it("emits a faded Hook dialogue on layer 2 for the first seconds", () => {
    const words = [w("你", 0, 1)];
    const ass = buildCaptionAss(words, 0, VERTICAL_LAYOUT, "karaoke", {
      openingHook: { text: "倒半杯水会怎样?", durationSec: 2.2 },
    });
    expect(ass).toContain("Style: Hook,");
    expect(ass).toContain("Dialogue: 2,0:00:00.00,0:00:02.20,Hook,,0,0,0,,{\\fad(220,300)}倒半杯水会怎样?");
  });

  it("hook coexists with the title card and captions (distinct layers)", () => {
    const words = [w("你", 0, 1)];
    const ass = buildCaptionAss(words, 0, VERTICAL_LAYOUT, "karaoke", {
      titleCard: { text: "标题", durationSec: 12 },
      openingHook: { text: "钩子句", durationSec: 2.2 },
    });
    expect(ass).toMatch(/^Dialogue: 1,.*,Title,/m);
    expect(ass).toMatch(/^Dialogue: 2,.*,Hook,/m);
    expect(ass).toMatch(/^Dialogue: 0,.*,Caption,/m); // karaoke line still there
  });

  it("no Hook dialogue when the teaser is blank", () => {
    const ass = buildCaptionAss([w("你", 0, 1)], 0, VERTICAL_LAYOUT, "karaoke", {
      openingHook: { text: "   ", durationSec: 2.2 },
    });
    expect(ass).not.toMatch(/,Hook,,/);
  });

  it("wraps a long teaser onto two lines", () => {
    const ass = buildCaptionAss([w("你", 0, 1)], 0, VERTICAL_LAYOUT, "karaoke", {
      openingHook: { text: "这是一句特别特别长的悬念钩子句要换行", durationSec: 2.2 },
    });
    const hookLine = ass.split("\n").find((l) => l.includes(",Hook,")) ?? "";
    expect(hookLine).toContain("\\N");
  });
});

describe("buildCaptionAss styles", () => {
  const words = "一二三四五六七八".split("").map((ch, i) => w(ch, i, i + 1));

  it("keyword style: white primary, no \\k tags, keyword override present", () => {
    const ass = buildCaptionAss(words, 0, VERTICAL_LAYOUT, "keyword", { keywords: ["三四"] });
    expect(ass).toContain(",&H00FFFFFF,&H00FFFFFF,"); // primary=white
    expect(ass).not.toContain("\\k");
    expect(ass).toContain("{\\c&H0D6EFF&\\fscx108\\fscy108}三四");
  });

  it("pop style: one dialogue per 2-4 char chunk with a damped intro, bigger font", () => {
    const ass = buildCaptionAss(words, 0, VERTICAL_LAYOUT, "pop");
    const dialogues = ass.match(/^Dialogue:/gm) ?? [];
    expect(dialogues.length).toBe(2); // 8 CJK chars = 16 units → two 8-unit chunks
    // 阻尼弹入:0.8→1.04→1.0,不再夸张过冲
    expect(ass).toContain("\\t(0,90,\\fscx104\\fscy104)");
    expect(ass).not.toContain("\\fscx135");
    expect(ass).toContain(`,${Math.round(VERTICAL_LAYOUT.fontSize * 1.45)},`);
    // chunk 2 starts when its first word starts
    expect(ass).toContain("Dialogue: 0,0:00:04.00,");
  });

  it("pop style: 块内当前词换色——首词即亮,提前 80ms 接棒,末词按词尾归白", () => {
    const unit = [w("一", 10, 11), w("二", 11, 12)];
    const s = popText(unit, 10);
    // 首词提前量夹回 0,起始即高亮;1000-80=920ms 时二词接棒切白
    expect(s).toContain("{\\c&H0D6EFF&\\t(920,920,\\c&HFFFFFF&)}一");
    // 二词:920ms 点亮,词尾 2000ms 归白
    expect(s).toContain("{\\c&HFFFFFF&\\t(920,920,\\c&H0D6EFF&)\\t(2000,2000,\\c&HFFFFFF&)}二");
  });

  it("popText: 品牌高亮色覆盖默认橙,拉丁词间保留空格", () => {
    const unit = [w("go", 0, 0.5), w("now", 0.5, 1)];
    const s = popText(unit, 0, "#00ff00");
    expect(s).toContain("\\c&H00FF00&"); // BGR
    expect(s).toContain("go ");
  });

  it("hormozi style: 短块 + 卡拉OK点亮 + 特大字/厚描边/硬阴影/60% 高度线", () => {
    const ass = buildCaptionAss(words, 0, VERTICAL_LAYOUT, "hormozi");
    const dialogues = ass.match(/^Dialogue:/gm) ?? [];
    expect(dialogues.length).toBe(2); // 8 汉字 = 16 units → 两个 10-unit 块
    // 块内逐词 \k 点亮(与 pop 的纯弹跳不同),块级顶入定格
    expect(ass).toContain("\\k");
    expect(ass).toContain("{\\fscx82\\fscy82\\t(0,70,\\fscx100\\fscy100)}");
    // 特大字 + 主色=点亮色(火焰橙)
    const styleLine = ass.split("\n").find((l) => l.startsWith("Style: Caption,")) ?? "";
    expect(styleLine).toContain(`,${Math.round(VERTICAL_LAYOUT.fontSize * 1.5)},`);
    expect(styleLine).toContain("&H000D6EFF");
    // 厚描边(+3)与硬阴影(3),位置在 40% marginV(≈60% 高度线)
    expect(styleLine).toContain(`,1,${VERTICAL_LAYOUT.outline + 3},3,2,`);
    expect(styleLine).toContain(`,${Math.round(VERTICAL_LAYOUT.playResY * 0.4)},`);
  });

  it("hormozi style: 拉丁词全大写,CJK 不受影响", () => {
    const ass = buildCaptionAss([w("买", 0, 1), w("it", 1, 2), w("now", 2, 3)], 0, VERTICAL_LAYOUT, "hormozi");
    expect(ass).toContain("IT");
    expect(ass).toContain("NOW");
    expect(ass).toContain("买");
    expect(ass).not.toMatch(/\}it/);
  });
});

describe("双语译文轨 (Trans)", () => {
  const words = [w("你", 10, 11), w("好", 11, 12)];

  it("译文行渲染为 Trans 样式,时间被 clipStartSec 平移", () => {
    const ass = buildCaptionAss(words, 10, VERTICAL_LAYOUT, "karaoke", {
      translation: [{ startSec: 10, endSec: 12, text: "Hello there" }],
    });
    expect(ass).toContain("Style: Trans,");
    expect(ass).toContain(",Trans,,0,0,0,,Hello there");
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:02.00,Trans");
    // 译文字号是主字幕的 0.6 倍
    expect(ass).toContain(`Style: Trans,Source Han Sans SC,${Math.round(VERTICAL_LAYOUT.fontSize * 0.6)},`);
  });

  it("超长译文按小号阈值手动折行(WrapStyle 2 不自动换行)", () => {
    const long = "This is a fairly long translated sentence that must wrap onto a second line";
    const ass = buildCaptionAss(words, 10, VERTICAL_LAYOUT, "karaoke", {
      translation: [{ startSec: 10, endSec: 12, text: long }],
    });
    const line = ass.split("\n").find((l) => l.includes(",Trans,"))!;
    expect(line).toContain("\\N");
  });

  it("没传 translation 时不产生 Trans 事件;空文本/零时长行跳过", () => {
    const plain = buildCaptionAss(words, 10, VERTICAL_LAYOUT, "karaoke", {});
    expect(plain.split("\n").some((l) => l.startsWith("Dialogue:") && l.includes(",Trans,"))).toBe(false);
    const ass = buildCaptionAss(words, 10, VERTICAL_LAYOUT, "karaoke", {
      translation: [
        { startSec: 10, endSec: 10, text: "zero" },
        { startSec: 10, endSec: 11, text: "  " },
      ],
    });
    expect(ass.split("\n").some((l) => l.startsWith("Dialogue:") && l.includes(",Trans,"))).toBe(false);
  });

  it("与卡拉OK主字幕同屏共存(双语两轨都在)", () => {
    const ass = buildCaptionAss(words, 10, VERTICAL_LAYOUT, "karaoke", {
      translation: [{ startSec: 10, endSec: 12, text: "Hi" }],
    });
    expect(ass).toContain("{\\k");
    expect(ass).toContain(",Trans,,0,0,0,,Hi");
  });
});

describe("AIGC 显式标识 (Aigc badge)", () => {
  it("开启时渲染左上角全程小字与专属样式", () => {
    const ass = buildCaptionAss([], 0, VERTICAL_LAYOUT, "karaoke", { aigcBadge: { durationSec: 12.5 } });
    expect(ass).toContain("Style: Aigc,");
    expect(ass).toContain("Dialogue: 3,0:00:00.00,0:00:12.50,Aigc,,0,0,0,,AI 生成");
    // 左上对齐(Alignment 7)且字号明显小于主字幕
    const style = ass.split("\n").find((l) => l.startsWith("Style: Aigc,"))!;
    expect(style.split(",")[18]).toBe("7");
    expect(Number(style.split(",")[2])).toBeLessThan(VERTICAL_LAYOUT.fontSize / 2);
  });

  it("未开启/零时长不产生事件", () => {
    expect(buildCaptionAss([], 0, VERTICAL_LAYOUT, "karaoke", {})).not.toContain(",Aigc,");
    expect(buildCaptionAss([], 0, VERTICAL_LAYOUT, "karaoke", { aigcBadge: { durationSec: 0 } })).not.toContain("Dialogue: 3");
  });
});
