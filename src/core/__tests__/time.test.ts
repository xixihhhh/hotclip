import { describe, it, expect } from "vitest";
import { formatDuration, toFfmpegTime, parseTimestamp } from "../time";

describe("formatDuration", () => {
  it("formats sub-hour durations as MM:SS", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(65)).toBe("01:05");
    expect(formatDuration(3599)).toBe("59:59");
  });

  it("formats hour+ durations as H:MM:SS", () => {
    expect(formatDuration(3600)).toBe("1:00:00");
    expect(formatDuration(7325)).toBe("2:02:05");
  });

  it("degrades gracefully on bad input", () => {
    expect(formatDuration(-5)).toBe("00:00");
    expect(formatDuration(NaN)).toBe("00:00");
  });
});

describe("toFfmpegTime", () => {
  it("emits HH:MM:SS.mmm", () => {
    expect(toFfmpegTime(0)).toBe("00:00:00.000");
    expect(toFfmpegTime(61.5)).toBe("00:01:01.500");
    expect(toFfmpegTime(3661.007)).toBe("01:01:01.007");
  });

  it("rounds sub-millisecond values instead of truncating", () => {
    expect(toFfmpegTime(1.9996)).toBe("00:00:02.000");
  });

  it("clamps negatives to zero", () => {
    expect(toFfmpegTime(-3)).toBe("00:00:00.000");
  });
});

describe("parseTimestamp", () => {
  it("parses SS / MM:SS / HH:MM:SS", () => {
    expect(parseTimestamp("42")).toBe(42);
    expect(parseTimestamp("1:30")).toBe(90);
    expect(parseTimestamp("01:00:05")).toBe(3605);
  });

  it("accepts fractional seconds", () => {
    expect(parseTimestamp("1:30.5")).toBe(90.5);
  });

  it("returns null on garbage", () => {
    expect(parseTimestamp("")).toBeNull();
    expect(parseTimestamp("abc")).toBeNull();
    expect(parseTimestamp("1:2:3:4")).toBeNull();
    expect(parseTimestamp("1:-2")).toBeNull();
  });
});
