import { describe, expect, it } from "vitest";
import { encoderCandidates, pickVideoEncoder, videoEncoderArgs } from "../video-encoder";

describe("hardware video encoder selection", () => {
  it("prefers the platform-native available encoder", () => {
    const output = " V..... h264_videotoolbox Apple VideoToolbox H.264 Encoder\n V....D libx264";
    expect(pickVideoEncoder(output, "darwin")).toBe("h264_videotoolbox");
    expect(encoderCandidates("win32")[0]).toBe("h264_nvenc");
  });

  it("falls back when bundled ffmpeg has no hardware encoder", () => {
    expect(pickVideoEncoder(" V....D libx264 H.264", "linux")).toBe("libx264");
  });

  it("maps quality to codec-specific arguments", () => {
    expect(videoEncoderArgs("libx264", 23, "medium")).toEqual(["-c:v", "libx264", "-preset", "medium", "-crf", "23"]);
    expect(videoEncoderArgs("h264_videotoolbox", 18)).toContain("64");
    expect(videoEncoderArgs("h264_nvenc", 28)).toContain("28");
    expect(videoEncoderArgs("h264_qsv", 23)).toContain("23");
  });
});
