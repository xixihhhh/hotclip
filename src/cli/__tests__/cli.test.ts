import { describe, it, expect } from "vitest";
import { parseCliArgs } from "../index";

describe("parseCliArgs (CLI 参数解析)", () => {
  it("clip 全默认:竖屏+字幕开,视频路径为首个非选项参数", () => {
    const a = parseCliArgs(["clip", "/v/直播回放.mp4"]);
    expect(a).toMatchObject({
      command: "clip",
      videoPath: "/v/直播回放.mp4",
      vertical: true,
      captions: true,
      json: false,
    });
  });

  it("开关与带值选项:--no-vertical / --no-captions / --max-clips / --out / --json", () => {
    const a = parseCliArgs(["clip", "/v/a.mp4", "--no-vertical", "--no-captions", "--max-clips", "3", "--out", "/tmp/o", "--json"]);
    expect(a.vertical).toBe(false);
    expect(a.captions).toBe(false);
    expect(a.maxClips).toBe(3);
    expect(a.outDir).toBe("/tmp/o");
    expect(a.json).toBe(true);
  });

  it("--max-clips 钳到 1..12(与 MCP 同一约束)", () => {
    expect(parseCliArgs(["clip", "/v/a.mp4", "--max-clips", "99"]).maxClips).toBe(12);
    expect(parseCliArgs(["clip", "/v/a.mp4", "--max-clips", "0"]).maxClips).toBe(1);
  });

  it("选项顺序无关:选项可在路径之前", () => {
    const a = parseCliArgs(["highlights", "--max-clips", "5", "/v/a.mp4"]);
    expect(a.videoPath).toBe("/v/a.mp4");
    expect(a.maxClips).toBe(5);
  });

  it("--reference 带值解析;缺值抛错", () => {
    const a = parseCliArgs(["highlights", "/v/a.mp4", "--reference", "/v/对标爆款.mp4"]);
    expect(a.referencePath).toBe("/v/对标爆款.mp4");
    expect(parseCliArgs(["clip", "/v/a.mp4"]).referencePath).toBeUndefined();
    expect(() => parseCliArgs(["clip", "/v/a.mp4", "--reference"])).toThrow(/对标视频路径/);
  });

  it("doctor 不需要视频路径,--download 可选", () => {
    expect(parseCliArgs(["doctor"])).toMatchObject({ command: "doctor", download: false });
    expect(parseCliArgs(["doctor", "--download"]).download).toBe(true);
  });

  it("缺命令/缺路径/未知选项/非法数值 → 抛出含用法的错误", () => {
    expect(() => parseCliArgs([])).toThrow(/用法/);
    expect(() => parseCliArgs(["clip"])).toThrow(/缺少视频路径/);
    expect(() => parseCliArgs(["clip", "/v/a.mp4", "--wat"])).toThrow(/未知选项/);
    expect(() => parseCliArgs(["clip", "/v/a.mp4", "--max-clips", "abc"])).toThrow(/数字/);
  });

  it("-h / --help → 输出用法", () => {
    expect(() => parseCliArgs(["--help"])).toThrow(/pnpm cli clip/);
  });
});
