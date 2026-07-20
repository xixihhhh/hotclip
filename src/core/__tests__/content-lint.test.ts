import { describe, it, expect } from "vitest";
import { lintText, lintClipContent, formatLintIssue } from "../content-lint";

describe("lintText (平台违禁词扫描)", () => {
  it("绝对化用语命中", () => {
    const hits = lintText("这款是全网最低价,销量第一的国家级产品");
    const terms = hits.map((h) => h.term);
    expect(terms).toContain("全网最低价");
    expect(terms).toContain("销量第一");
    expect(terms).toContain("国家级");
    expect(hits.every((h) => h.category === "绝对化用语")).toBe(true);
  });

  it("医疗功效与承诺类命中,类别正确", () => {
    const hits = lintText("三天见效,根治脱发,无效退款");
    expect(hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ term: "根治", category: "医疗功效宣称" }),
        expect.objectContaining({ term: "三天见效", category: "夸大承诺" }),
        expect.objectContaining({ term: "无效退款", category: "夸大承诺" }),
      ])
    );
  });

  it("收益承诺与导流话术命中", () => {
    const hits = lintText("躺赚月入过万,想要的加微信私信我领取");
    const terms = hits.map((h) => h.term);
    expect(terms).toContain("躺赚");
    expect(terms).toContain("月入过万");
    expect(terms).toContain("加微信");
    expect(terms).toContain("私信我领");
  });

  it("同一词多次出现只报一次", () => {
    const hits = lintText("最低价!今天最低价!还是最低价!");
    expect(hits.filter((h) => h.term === "最低价")).toHaveLength(1);
  });

  it("日常口语不误报(裸「最/第一」不在规则里)", () => {
    expect(lintText("我最近在减脂,今天第一次直播,最后聊聊感受")).toEqual([]);
    expect(lintText("这个功能特别好用,大家可以试试")).toEqual([]);
  });

  it("空文本返回空", () => {
    expect(lintText("")).toEqual([]);
  });
});

describe("lintClipContent (整条切片的物料扫描)", () => {
  it("按物料来源分别报告;字幕按字拼接也能扫到跨词命中", () => {
    const hits = lintClipContent({
      title: "全网最低价的秘密",
      hook: "看完你就知道怎么躺赚",
      publish: { title: "买它", hashtags: ["#好物"], description: "假一赔十,无效退款" },
      // 中文 ASR 按字出词:「根」「治」相邻拼接后才可命中
      captionText: "这个方子能根治老胃病",
    });
    expect(hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ term: "全网最低价", source: "title" }),
        expect.objectContaining({ term: "躺赚", source: "hook" }),
        expect.objectContaining({ term: "假一赔十", source: "publish" }),
        expect.objectContaining({ term: "无效退款", source: "publish" }),
        expect.objectContaining({ term: "根治", source: "caption" }),
      ])
    );
  });

  it("同一词在不同物料各报一次(要分别改)", () => {
    const hits = lintClipContent({ title: "最低价来了", captionText: "今天最低价" });
    expect(hits.filter((h) => h.term === "最低价")).toHaveLength(2);
  });

  it("全部缺省/干净物料 → 空命中", () => {
    expect(lintClipContent({})).toEqual([]);
    expect(lintClipContent({ title: "分享一个学习方法", captionText: "坚持就有收获" })).toEqual([]);
  });
});

describe("formatLintIssue (告警文案)", () => {
  it("无命中返回 null", () => {
    expect(formatLintIssue([])).toBeNull();
  });

  it("点名词+类别+来源;超过 5 个归入「等 N 处」", () => {
    const one = formatLintIssue([{ term: "根治", category: "医疗功效宣称", source: "caption" }]);
    expect(one).toContain("「根治」");
    expect(one).toContain("医疗功效宣称");
    expect(one).toContain("字幕");
    const many = formatLintIssue(
      Array.from({ length: 7 }, (_, i) => ({ term: `词${i}`, category: "绝对化用语", source: "publish" as const }))
    );
    expect(many).toContain("等 7 处");
  });
});
