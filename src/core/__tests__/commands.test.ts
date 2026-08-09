/**
 * 主播口令打点(v0.13):「这段剪下来/clip that」是主播自证的爆点。
 * 误报代价低(提示词里多一行证据),但高频日常语(切换/这段时间)必须排掉,
 * 不然满屏假口令会稀释真信号。
 */
import { describe, it, expect } from "vitest";
import { isClipCommand, detectClipCommands, COMMAND_MAX_MARKS } from "../highlight/commands";
import type { Transcript } from "../transcribe/types";

function tx(sentences: Array<[string, number]>): Transcript {
  return {
    language: "zh",
    engine: "test",
    durationSec: sentences[sentences.length - 1]?.[1] ?? 0,
    segments: sentences.map(([text, startSec], i) => ({
      id: i + 1,
      startSec,
      endSec: startSec + 3,
      text,
      words: [],
    })),
  };
}

describe("isClipCommand", () => {
  it("命中常见中文剪辑口令", () => {
    for (const s of [
      "这段给我剪下来",
      "把这段剪下来发抖音",
      "刚才那段切出来",
      "记得把这个剪下来啊",
      "帮我剪个切片",
      "后期把这段剪了",
      "切片君剪一下这段",
      "这段剪出来绝对爆",
    ]) {
      expect(isClipCommand(s), s).toBe(true);
    }
  });

  it("命中英文口令", () => {
    for (const s of ["clip that", "someone clip this moment", "that's a clip right there", "CLIP IT"]) {
      expect(isClipCommand(s), s).toBe(true);
    }
  });

  it("不误伤日常用语", () => {
    for (const s of [
      "这段时间我剪了很多视频", // 「这段时间」排除
      "我们切换到下一个话题", // 切换排除
      "我平时用剪映做剪辑",
      "把它切成两半就能吃了",
      "切一下水果给大家看",
      "这段感情让我成长了很多",
      "a clip from yesterday", // 名词用法
      "今天聊聊剪辑技巧",
    ]) {
      expect(isClipCommand(s), s).toBe(false);
    }
  });
});

describe("detectClipCommands", () => {
  it("返回命中句的时刻,近距离命中只记一次", () => {
    const t = tx([
      ["大家好", 0],
      ["这段剪下来", 100],
      ["对就是刚才那段切出来", 110], // 与上一条相距 <20s,去重
      ["正常聊天", 200],
      ["clip that", 300],
    ]);
    expect(detectClipCommands(t)).toEqual([100, 300]);
  });

  it("总量截断防口头禅刷屏", () => {
    const many = Array.from({ length: 40 }, (_, i) => ["这段剪下来", i * 30] as [string, number]);
    expect(detectClipCommands(tx(many))).toHaveLength(COMMAND_MAX_MARKS);
  });

  it("没有口令时返回空数组", () => {
    expect(detectClipCommands(tx([["今天聊聊选品", 0]]))).toEqual([]);
  });
});
