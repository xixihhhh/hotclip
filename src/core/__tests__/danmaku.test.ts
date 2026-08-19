import { describe, it, expect } from "vitest";
import {
  parseBiliDanmakuXml,
  parseDouyinDanmakuJsonl,
  danmakuWeight,
  danmakuPeaks,
  danmakuPathFor,
  danmakuPathsFor,
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

  it("p 属性第 7 字段解析为发送者;占位 0 不算", () => {
    const xml = `<i>
      <d p="10,1,25,16777215,1720000000,0,abc123,rid">带 uid</d>
      <d p="20,1,25,16777215,1720000000,0,0,rid">占位 uid</d>
      <d p="30,1">老格式没有 uid</d>
    </i>`;
    const items = parseBiliDanmakuXml(xml);
    expect(items[0].uid).toBe("abc123");
    expect(items[1].uid).toBeUndefined();
    expect(items[2].uid).toBeUndefined();
  });

  it("录播姬扩展的 SC/礼物/舰长按付费档解析;没有 ts 的跳过", () => {
    const xml = `<i>
      <d p="5,1,25,16777215,1720000000,0,u1,rid">普通弹幕</d>
      <sc ts="100.5" uid="u2" price="30">太好笑了</sc>
      <gift ts="50" uid="u3" giftname="小心心" giftcount="10"/>
      <guard ts="70" user="u4" level="3"/>
      <gift uid="u5" giftname="没时间戳"/>
    </i>`;
    const items = parseBiliDanmakuXml(xml);
    expect(items.map((d) => d.t)).toEqual([5, 50, 70, 100.5]);
    const sc = items.find((d) => d.t === 100.5)!;
    expect(sc.text).toBe("太好笑了");
    expect(sc.boost).toBe(6); // SC 是观众花钱说话,一条顶一波弹幕
    expect(sc.uid).toBe("u2");
    expect(items.find((d) => d.t === 50)!.boost).toBe(1); // 免费小礼物只算一票
    expect(items.find((d) => d.t === 70)!.boost).toBe(6);
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

  it("反刷屏:一个人刷出来的爆发被打折,不当全场沸腾", () => {
    // 同样 20 条高能弹幕的爆发:全出自一人 vs 出自 20 人
    const base: DanmakuItem[] = [];
    for (let t = 0; t < 1200; t += 20) base.push({ t, text: "普通聊天", uid: `bg${t}` });
    const spam = [...base];
    for (let i = 0; i < 20; i++) spam.push({ t: 300 + i * 0.4, text: "哈哈哈哈", uid: "spammer" });
    const crowd = [...base];
    for (let i = 0; i < 20; i++) crowd.push({ t: 300 + i * 0.4, text: "哈哈哈哈", uid: `u${i}` });
    expect(danmakuPeaks(spam.sort((a, b) => a.t - b.t), 1200)).toEqual([]);
    const peaks = danmakuPeaks(crowd.sort((a, b) => a.t - b.t), 1200);
    expect(peaks.length).toBe(1);
    expect(peaks[0].startSec).toBeLessThanOrEqual(300);
  });

  it("没有 uid 的老格式不做刷屏惩罚(fail-open)", () => {
    const items: DanmakuItem[] = [];
    for (let t = 0; t < 1200; t += 20) items.push({ t, text: "普通聊天" });
    for (let i = 0; i < 20; i++) items.push({ t: 300 + i * 0.4, text: "哈哈哈哈" });
    expect(danmakuPeaks(items.sort((a, b) => a.t - b.t), 1200).length).toBe(1);
  });

  it("突发加成:突然的小爆发能过线,同等密度的全场温热不圈", () => {
    // 6 条/窗的突发:裸权重 6 不到 8,加上突升加成 (6-0)*0.5 = 9 过线
    const burst: DanmakuItem[] = [];
    for (let t = 0; t < 1200; t += 40) burst.push({ t, text: "普通聊天" });
    for (let i = 0; i < 6; i++) burst.push({ t: 500 + i * 0.4, text: "有点意思" });
    const peaks = danmakuPeaks(burst.sort((a, b) => a.t - b.t), 1200);
    expect(peaks.length).toBe(1);
    expect(peaks[0].startSec).toBeLessThanOrEqual(500);
    // 全场都是 6 条/窗:窗间没有跳升,中位数阈值也随基线抬高 → 不圈
    const warm: DanmakuItem[] = [];
    for (let t = 0; t < 1200; t += 1.7) warm.push({ t: Number(t.toFixed(1)), text: "一直聊" });
    expect(danmakuPeaks(warm, 1200)).toEqual([]);
  });
});

describe("danmakuPathFor", () => {
  it("同名 .xml(录播姬约定)", () => {
    expect(danmakuPathFor("/rec/直播回放-2026.flv")).toBe("/rec/直播回放-2026.xml");
    expect(danmakuPathFor("/rec/a.b.mp4")).toBe("/rec/a.b.xml");
  });
});

describe("parseDouyinDanmakuJsonl", () => {
  it("chat 计弹幕;gift/social/like 按互动档;member/roomStats 不计", () => {
    const jsonl = [
      `{"type":"chat","content":"主播牛的","userId":123456,"recvTimeSec":10.5}`,
      `{"type":"gift","giftName":"小心心","comboCount":10,"userName":"阿强","recvTimeSec":20}`,
      `{"type":"social","userName":"路人甲","action":1,"recvTimeSec":30}`,
      `{"type":"like","count":15,"total":9999,"userName":"路人乙","recvTimeSec":40}`,
      `{"type":"member","userName":"新观众","memberCount":50,"recvTimeSec":50}`,
      `{"type":"roomStats","displayLong":"1234人在线","recvTimeSec":60}`,
    ].join("\n");
    const items = parseDouyinDanmakuJsonl(jsonl);
    expect(items.map((d) => d.t)).toEqual([10.5, 20, 30, 40]); // member/roomStats 被跳过
    expect(items[0]).toMatchObject({ text: "主播牛的", uid: "123456" });
    expect(items[0].boost).toBeUndefined(); // 普通弹幕走高能词加权
    expect(items[1]).toMatchObject({ text: "小心心", boost: 1, uid: "阿强" });
    expect(items[2].boost).toBe(2); // 关注是用行动投票
    expect(items[3].boost).toBe(1);
  });

  it("坏行/空行跳过(录制进程被杀时最后一行常是半截)", () => {
    const jsonl = `{"type":"chat","content":"完整的","recvTimeSec":5}\n\n{"type":"chat","content":"半截`;
    const items = parseDouyinDanmakuJsonl(jsonl);
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("完整的");
  });

  it("纪元时间戳不认——对不上时间轴的消息宁可丢,不能落在第 0 秒污染开头", () => {
    const jsonl = [
      `{"type":"chat","content":"只有纪元秒","timestamp":1720000000}`,
      `{"type":"chat","content":"相对秒优先","recvTimeSec":12,"timestamp":1720000000}`,
    ].join("\n");
    const items = parseDouyinDanmakuJsonl(jsonl);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ text: "相对秒优先", t: 12 });
  });

  it("垃圾输入返回空", () => {
    expect(parseDouyinDanmakuJsonl("")).toEqual([]);
    expect(parseDouyinDanmakuJsonl("not json at all")).toEqual([]);
  });
});

describe("danmakuPathsFor", () => {
  it("按优先级:同名 .xml → 同名 .jsonl → {首段}_danmaku.jsonl", () => {
    expect(danmakuPathsFor("/rec/300294032039_merged.mp4")).toEqual([
      "/rec/300294032039_merged.xml",
      "/rec/300294032039_merged.jsonl",
      "/rec/300294032039_danmaku.jsonl",
    ]);
  });

  it("视频名没有下划线时只有前两个候选", () => {
    expect(danmakuPathsFor("/rec/回放.flv")).toEqual(["/rec/回放.xml", "/rec/回放.jsonl"]);
  });
});
