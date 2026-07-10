import { describe, it, expect } from "vitest";
import {
  parseBiliDanmakuXml,
  danmakuWeight,
  danmakuPeaks,
  danmakuPathFor,
  type DanmakuItem,
} from "../danmaku";

describe("parseBiliDanmakuXml", () => {
  it("解析录播姬/主站格式,时间取 p 首字段,按时间排序", () => {
    const xml = `<?xml version="1.0"?><i>
      <d p="65.3,1,25,16777215,1720000000,0,uid,rid">哈哈哈哈</d>
      <d p="12.5,4,25,65535,1720000001,0,uid,rid">前面的弹幕</d>
      <d p="66.0,1,25,16777215,1720000002,0,uid,rid">666</d>
    </i>`;
    const items = parseBiliDanmakuXml(xml);
    expect(items.map((d) => d.t)).toEqual([12.5, 65.3, 66.0]);
    expect(items[1].text).toBe("哈哈哈哈");
  });

  it("坏条目/空文本/负时间跳过;HTML 实体还原", () => {
    const xml = `<i>
      <d p="abc,1">时间坏了</d>
      <d p="5,1">   </d>
      <d p="-3,1">负数</d>
      <d p="8,1">a &amp;&lt;b&gt; ok</d>
    </i>`;
    const items = parseBiliDanmakuXml(xml);
    expect(items.length).toBe(1);
    expect(items[0].text).toBe("a &<b> ok");
  });

  it("非弹幕 XML/垃圾输入返回空", () => {
    expect(parseBiliDanmakuXml("<html><body>404</body></html>")).toEqual([]);
    expect(parseBiliDanmakuXml("")).toEqual([]);
  });
});

describe("danmakuWeight", () => {
  it("高能反应词翻倍", () => {
    for (const hype of ["哈哈哈哈", "233333", "666", "草", "泪目", "awsl", "笑死我了", "牛逼", "绷不住了"]) {
      expect(danmakuWeight(hype)).toBe(2);
    }
    expect(danmakuWeight("主播今天吃了什么")).toBe(1);
  });
});

describe("danmakuPeaks", () => {
  // 构造:全场稀弹幕(每 20s 一条),在 300-315s 处塞一波高能弹幕
  function burstItems(): DanmakuItem[] {
    const items: DanmakuItem[] = [];
    for (let t = 0; t < 1200; t += 20) items.push({ t, text: "普通聊天" });
    for (let i = 0; i < 30; i++) items.push({ t: 300 + i * 0.5, text: i % 2 ? "哈哈哈哈" : "666" });
    return items.sort((a, b) => a.t - b.t);
  }

  it("弹幕爆发段被圈出,冷场段不圈", () => {
    const peaks = danmakuPeaks(burstItems(), 1200);
    expect(peaks.length).toBe(1);
    expect(peaks[0].startSec).toBeLessThanOrEqual(300);
    expect(peaks[0].endSec).toBeGreaterThanOrEqual(314);
  });

  it("全场均匀(无峰)不圈段——阈值随基线自适应", () => {
    const flat: DanmakuItem[] = [];
    for (let t = 0; t < 1200; t += 2) flat.push({ t, text: "刷屏但均匀" });
    expect(danmakuPeaks(flat, 1200)).toEqual([]);
  });

  it("弹幕太稀(峰值窗权重不足)不给伪峰", () => {
    const sparse: DanmakuItem[] = [
      { t: 100, text: "一" },
      { t: 102, text: "二" },
      { t: 104, text: "三" },
    ];
    expect(danmakuPeaks(sparse, 1200)).toEqual([]);
  });

  it("空输入/短视频返回空", () => {
    expect(danmakuPeaks([], 1200)).toEqual([]);
    expect(danmakuPeaks([{ t: 1, text: "x" }], 5)).toEqual([]);
  });
});

describe("danmakuPathFor", () => {
  it("同名 .xml(录播姬约定)", () => {
    expect(danmakuPathFor("/rec/直播回放-2026.flv")).toBe("/rec/直播回放-2026.xml");
    expect(danmakuPathFor("/rec/a.b.mp4")).toBe("/rec/a.b.xml");
  });
});
