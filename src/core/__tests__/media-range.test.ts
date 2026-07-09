import { describe, it, expect } from "vitest";
import { resolveByteRange } from "../media-range";

describe("resolveByteRange", () => {
  const SIZE = 1000;

  it("无 Range 头 → 整文件 200", () => {
    expect(resolveByteRange(null, SIZE)).toEqual({ start: 0, end: 999, status: 200 });
    expect(resolveByteRange("", SIZE)).toEqual({ start: 0, end: 999, status: 200 });
  });

  it("bytes=a-b → 闭区间分段;终点越界截到文件尾", () => {
    expect(resolveByteRange("bytes=0-499", SIZE)).toEqual({ start: 0, end: 499, status: 206 });
    expect(resolveByteRange("bytes=500-99999", SIZE)).toEqual({ start: 500, end: 999, status: 206 });
  });

  it("bytes=a- → 从 a 到文件尾(拖进度条的主形态)", () => {
    expect(resolveByteRange("bytes=200-", SIZE)).toEqual({ start: 200, end: 999, status: 206 });
  });

  it("bytes=-n → 末尾 n 字节(mp4 找 moov atom 用)", () => {
    expect(resolveByteRange("bytes=-100", SIZE)).toEqual({ start: 900, end: 999, status: 206 });
    // n 超过文件大小 → 整文件但仍是 206
    expect(resolveByteRange("bytes=-5000", SIZE)).toEqual({ start: 0, end: 999, status: 206 });
  });

  it("不可满足的范围 → null(调用方回 416)", () => {
    expect(resolveByteRange("bytes=1000-", SIZE)).toBeNull();
    expect(resolveByteRange("bytes=800-200", SIZE)).toBeNull();
  });

  it("不识别的形态按整文件处理(不 5xx)", () => {
    expect(resolveByteRange("bytes=0-499,600-999", SIZE)).toEqual({ start: 0, end: 999, status: 200 });
    expect(resolveByteRange("items=0-1", SIZE)).toEqual({ start: 0, end: 999, status: 200 });
  });
});
