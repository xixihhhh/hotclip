import { describe, it, expect } from "vitest";
import { secToTimecode, buildEdl } from "../edl";

describe("secToTimecode", () => {
  it("SMPTE 非丢帧时间码,帧数按 fps 换算", () => {
    expect(secToTimecode(0, 30)).toBe("00:00:00:00");
    expect(secToTimecode(65.5, 30)).toBe("00:01:05:15");
    expect(secToTimecode(3661.2, 25)).toBe("01:01:01:05");
  });

  it("非整数 fps(29.97)舍入到整数帧基;负数夹零", () => {
    expect(secToTimecode(1, 29.97)).toBe("00:00:01:00");
    expect(secToTimecode(-5, 30)).toBe("00:00:00:00");
  });
});

describe("buildEdl", () => {
  it("CMX3600 结构:标题/FCM/事件行/注释行,record 侧连续累计", () => {
    const edl = buildEdl({
      title: "回放 - HotClip",
      sourceName: "回放.mp4",
      fps: 30,
      clips: [
        { title: "爆点一", segments: [{ startSec: 60, endSec: 70 }] },
        { title: "爆点二", segments: [{ startSec: 200, endSec: 215 }] },
      ],
    });
    expect(edl).toContain("TITLE: 回放 - HotClip");
    expect(edl).toContain("FCM: NON-DROP FRAME");
    expect(edl).toContain("001  AX       B     C        00:01:00:00 00:01:10:00 00:00:00:00 00:00:10:00");
    // 第二条 record 从 10s 继续
    expect(edl).toContain("002  AX       B     C        00:03:20:00 00:03:35:00 00:00:10:00 00:00:25:00");
    expect(edl).toContain("* FROM CLIP NAME: 回放.mp4");
    expect(edl).toContain("* COMMENT: 爆点一");
  });

  it("跳剪多段:一条切片拆成多个事件,源片跳跃 record 连续", () => {
    const edl = buildEdl({
      title: "t",
      sourceName: "s.mp4",
      fps: 30,
      clips: [
        {
          title: "跳剪片",
          segments: [
            { startSec: 100, endSec: 104 },
            { startSec: 106, endSec: 110 }, // 中间 2s 被跳剪剪掉
          ],
        },
      ],
    });
    const events = edl.split("\n").filter((l) => /^\d{3} {2}AX/.test(l));
    expect(events.length).toBe(2);
    expect(events[0]).toContain("00:01:40:00 00:01:44:00 00:00:00:00 00:00:04:00");
    expect(events[1]).toContain("00:01:46:00 00:01:50:00 00:00:04:00 00:00:08:00");
  });

  it("零时长段跳过,事件编号仍连续", () => {
    const edl = buildEdl({
      title: "t",
      sourceName: "s.mp4",
      fps: 30,
      clips: [
        { title: "a", segments: [{ startSec: 5, endSec: 5 }, { startSec: 10, endSec: 12 }] },
      ],
    });
    const events = edl.split("\n").filter((l) => /^\d{3} {2}AX/.test(l));
    expect(events.length).toBe(1);
    expect(events[0].startsWith("001")).toBe(true);
  });
});
