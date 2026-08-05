import { describe, it, expect } from "vitest";
import {
  planSfxCues,
  buildSoundDesignArgs,
  hasSoundDesignWork,
  synthSfxArgs,
  SFX_MAX_PER_CLIP,
  SFX_MIN_SPACING_SEC,
  SFX_TYPES,
} from "../sound-design";

describe("planSfxCues", () => {
  it("拼接缝 whoosh + 情绪峰 ding + 钩子 pop,按时间序返回", () => {
    const cues = planSfxCues({
      durationSec: 30,
      seamsSec: [12],
      hookAtSec: 0.05,
      peakEventsSec: [20],
    });
    expect(cues.map((c) => c.type)).toEqual(["pop", "whoosh", "ding"]);
    expect(cues.map((c) => c.atSec)).toEqual([0.05, 12, 20]);
  });

  it("超出上限的打点被丢弃(结构缝优先)", () => {
    const cues = planSfxCues({
      durationSec: 60,
      seamsSec: [10, 20, 30, 40],
      hookAtSec: 0.05,
      peakEventsSec: [50],
    });
    expect(cues).toHaveLength(SFX_MAX_PER_CLIP);
    expect(cues.every((c) => c.type === "whoosh")).toBe(true);
  });

  it("违反最小间距的打点被丢弃而不是挪位置", () => {
    const cues = planSfxCues({
      durationSec: 30,
      seamsSec: [10],
      peakEventsSec: [10.5], // 距 whoosh 仅 0.5s < 最小间距
    });
    expect(cues).toHaveLength(1);
    expect(cues[0].type).toBe("whoosh");
    expect(SFX_MIN_SPACING_SEC).toBeGreaterThan(0.5);
  });

  it("贴片尾的打点被丢弃;太短的片一个都不打", () => {
    expect(planSfxCues({ durationSec: 30, peakEventsSec: [29.8] })).toHaveLength(0);
    expect(planSfxCues({ durationSec: 0.5, seamsSec: [0.2] })).toHaveLength(0);
  });

  it("没有任何素材时返回空", () => {
    expect(planSfxCues({ durationSec: 30 })).toHaveLength(0);
  });
});

describe("buildSoundDesignArgs", () => {
  it("音效走 adelay 到打点毫秒,视频流复制", () => {
    const args = buildSoundDesignArgs("in.mp4", "out.mp4", {
      cues: [{ type: "ding", atSec: 12.345 }],
      sfxDir: "/sfx",
      durationSec: 30,
    });
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("adelay=12345|12345");
    expect(graph).toContain("amix=inputs=2");
    expect(graph).toContain("normalize=0");
    // 不重编视频:后处理趟画质零损失是硬承诺
    expect(args.join(" ")).toContain("-map 0:v? -c:v copy");
    // 没开响度标准化时用限幅器兜底防削波
    expect(graph).toContain("alimiter");
  });

  it("BGM:循环读入、衰减、对人声侧链闪避、收尾淡出", () => {
    const args = buildSoundDesignArgs("in.mp4", "out.mp4", {
      cues: [],
      bgmPath: "/music/bgm.mp3",
      durationSec: 30,
      normalizeLoudness: true,
    });
    const joined = args.join(" ");
    expect(joined).toContain("-stream_loop -1");
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("asplit=2[voice][sc]");
    expect(graph).toContain("sidechaincompress");
    expect(graph).toContain("volume=-17dB");
    expect(graph).toContain("afade=t=out:st=28.800");
    // 开了响度标准化:混完再过一遍 loudnorm 保住 -14 目标
    expect(graph).toContain("loudnorm");
  });

  it("无事可做时抛错(调用方应先用 hasSoundDesignWork 把关)", () => {
    expect(() => buildSoundDesignArgs("a.mp4", "b.mp4", { cues: [], durationSec: 10 })).toThrow();
    expect(hasSoundDesignWork({ cues: [] })).toBe(false);
    expect(hasSoundDesignWork({ cues: [], bgmPath: "/x.mp3" })).toBe(true);
    expect(hasSoundDesignWork({ cues: [{ type: "pop", atSec: 0 }] })).toBe(true);
  });
});

describe("synthSfxArgs", () => {
  it("三类音效各有合成配方,统一 48k 单声道 wav", () => {
    for (const type of SFX_TYPES) {
      const args = synthSfxArgs(type, `/tmp/${type}.wav`);
      expect(args).toContain("lavfi");
      expect(args.join(" ")).toContain("-ar 48000 -ac 1");
      expect(args[args.length - 1]).toBe(`/tmp/${type}.wav`);
    }
  });
});
