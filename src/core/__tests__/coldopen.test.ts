import { describe, it, expect } from "vitest";
import { planColdOpen, COLD_OPEN_MAX_SEC, COLD_OPEN_MIN_SEC } from "../coldopen";
import type { TranscriptWord } from "../../shared/api-types";

/** 每字 0.5s 的等宽词流,从 startSec 起。 */
function words(text: string, startSec: number, perChar = 0.5): TranscriptWord[] {
  return Array.from(text).map((ch, i) => ({
    text: ch,
    startSec: startSec + i * perChar,
    endSec: startSec + (i + 1) * perChar,
  }));
}

describe("planColdOpen", () => {
  // 切片 100s 起,前 12s 是铺垫,钩子句「直接倒半杯水都不带渗」在 112s 起
  const clipStart = 100;
  const clipWords = [...words("今天给大家带来一款超级好用的纸巾三层加厚", clipStart), ...words("直接倒半杯水都不带渗", 112)];

  it("定位钩子句并返回其词边界区间(10 字×0.5s=5s,超 MAX=4s 截到 116s)", () => {
    const p = planColdOpen(clipWords, "直接倒半杯水都不带渗", clipStart);
    expect(p).not.toBeNull();
    expect(p!.startSec).toBeCloseTo(112, 3);
    expect(p!.endSec).toBeCloseTo(116, 3);
  });

  it("钩子句超长:从句首截到 MAX 并收口到词尾", () => {
    const p = planColdOpen(clipWords, "直接倒半杯水都不带渗", clipStart)!;
    expect(p.endSec - p.startSec).toBeLessThanOrEqual(COLD_OPEN_MAX_SEC + 1e-6);
    // 词边界收口:endSec 必须等于某个词的 endSec
    expect(clipWords.some((w) => Math.abs(w.endSec - p.endSec) < 1e-6)).toBe(true);
  });

  it("钩子离切片开头太近(<10s)→ 跳过", () => {
    const near = [...words("开场白", 100), ...words("爆点句在这里", 103), ...words("后续内容继续说", 108)];
    expect(planColdOpen(near, "爆点句在这里", 100)).toBeNull();
  });

  it("钩子定位失败/空钩子/过短片段 → null(宁可不做不可做错)", () => {
    expect(planColdOpen(clipWords, "转写里根本没有这句", clipStart)).toBeNull();
    expect(planColdOpen(clipWords, "", clipStart)).toBeNull();
    expect(planColdOpen([], "直接倒", clipStart)).toBeNull();
    // 命中但只有一个字(0.5s < MIN=1s)
    const tiny = [...words("很长的铺垫内容一直在说话不停地说", 100), ...words("炸", 115)];
    expect(planColdOpen(tiny, "炸", 100)).toBeNull();
    expect(COLD_OPEN_MIN_SEC).toBeGreaterThan(0.5);
  });

  it("引用与转写标点/大小写有出入仍能对齐(同选段的归一化匹配)", () => {
    const p = planColdOpen(clipWords, "直接倒半杯水,都不带渗!", clipStart);
    expect(p).not.toBeNull();
    expect(p!.startSec).toBeCloseTo(112, 3);
  });
});
