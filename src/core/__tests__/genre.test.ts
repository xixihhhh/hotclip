import { describe, it, expect } from "vitest";
import {
  GENRE_PRESETS,
  GENRE_CUSTOM_MAX_CHARS,
  genrePreset,
  genreSection,
  normalizeGenreId,
} from "../genre";

describe("genrePreset", () => {
  it("按 id 取到对应预设", () => {
    expect(genrePreset("game").id).toBe("game");
    expect(genrePreset("show").labelZh).toContain("舞见");
  });

  it("未知/空 id 回落通用档,不抛异常", () => {
    expect(genrePreset("不存在的品类").id).toBe("auto");
    expect(genrePreset(undefined).id).toBe("auto");
  });

  it("每个内置预设中英文都有标签,且除 auto/custom 外都有判据", () => {
    for (const g of GENRE_PRESETS) {
      expect(g.labelZh).not.toBe("");
      expect(g.labelEn).not.toBe("");
      if (g.id !== "auto" && g.id !== "custom") {
        expect(g.criteriaZh.length).toBeGreaterThan(50);
        expect(g.criteriaEn.length).toBeGreaterThan(50);
      }
    }
  });

  it("id 不重复(下拉里不许出现两个同名项)", () => {
    const ids = GENRE_PRESETS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("分区口径对齐平台真实分类", () => {
  // 分区表按 B站直播 Area/getList(11 个一级分区)+ 抖音/斗鱼公开分区归并而来。
  // 这些是我自己拍脑袋列时漏掉、看了真实分类才补上的品类——回归时要守住。
  it("覆盖 B站一级分区里容易被漏掉的几类", () => {
    const ids = GENRE_PRESETS.map((g) => g.id);
    for (const must of ["vtuber", "radio", "pet", "food", "esports", "craft", "cowatch", "looks", "sports"]) {
      expect(ids).toContain(must);
    }
  });

  it("每个预设都标了证据类别,且三类都有代表", () => {
    const classes = new Set(GENRE_PRESETS.map((g) => g.evidence));
    expect(classes).toEqual(new Set(["words", "reaction", "visual"]));
    // 文字稿最没用的那几类必须不是 words,否则信号通道根本不会跑
    for (const id of ["show", "pet", "food", "craft"]) {
      expect(genrePreset(id).evidence).toBe("visual");
    }
    for (const id of ["game", "outdoor", "vtuber", "radio", "esports"]) {
      expect(genrePreset(id).evidence).toBe("reaction");
    }
  });

  it("旧偏好里的 id 仍然认(分区重排不能让本机设置失效)", () => {
    expect(normalizeGenreId("live-sell")).toBe("shopping");
    expect(normalizeGenreId("gaming")).toBe("game");
    expect(normalizeGenreId("lecture")).toBe("knowledge");
    expect(normalizeGenreId("show")).toBe("show");
    expect(normalizeGenreId(undefined)).toBeUndefined();
    // 走到 genreSection 也要真的拿到新判据
    expect(genreSection("live-sell", true)).toContain("带货直播");
  });
});

describe("genreSection", () => {
  it("通用档不注入任何内容(保持原有通用判据)", () => {
    expect(genreSection("auto", true)).toBe("");
    expect(genreSection(undefined, false)).toBe("");
  });

  it("按语言给对应判据", () => {
    expect(genreSection("shopping", true)).toContain("带货直播");
    expect(genreSection("shopping", false)).toContain("Live-selling");
  });

  it("自定义判据盖过内置预设(选个最接近的再改两句)", () => {
    const out = genreSection("game", true, "只要老板骂人的片段");
    expect(out).toContain("只要老板骂人的片段");
    expect(out).not.toContain("极限操作");
  });

  it("空白自定义不算数,仍用预设", () => {
    expect(genreSection("game", true, "   ")).toContain("极限操作");
    expect(genreSection("game", true, "")).toContain("极限操作");
  });

  it("自定义判据超长会被截断(不许塞爆提示词)", () => {
    const huge = "很长的判据".repeat(1000);
    const out = genreSection("custom", true, huge);
    expect(out.length).toBeLessThan(GENRE_CUSTOM_MAX_CHARS + 100);
  });

  it("custom 预设自身没有内置判据,没填自定义就不注入", () => {
    expect(genreSection("custom", true)).toBe("");
  });

  it("文字稿不可信的品类都明说了别信文字稿", () => {
    expect(genreSection("game", true)).toContain("不要只看文字稿");
    expect(genreSection("show", true)).toContain("文字稿基本没有信息量");
    expect(genreSection("pet", true)).toContain("文字稿完全不能作为判据");
    expect(genreSection("outdoor", true)).toContain("户外收音差");
  });

  it("虚拟主播档点明表情信号无效(脸是模型不是人)", () => {
    expect(genreSection("vtuber", true)).toContain("人脸表情信号基本无效");
  });

  it("电台档点明没有画面(纯音频成片走波形图)", () => {
    expect(genreSection("radio", true)).toContain("没有画面可用");
  });

  it("一起看档把版权风险写在最前面——这条比选得好不好重要", () => {
    const out = genreSection("cowatch", true);
    expect(out).toContain("版权");
    expect(out).toContain("不要把影视画面本身切成片");
  });
});
