import { describe, it, expect } from "vitest";
import { planFlashForward, FLASH_LEAD_SEC, FLASH_TAIL_SEC, FLASH_MIN_SEC } from "../coldopen";
import { missingHookPayoffs } from "../qa";

describe("planFlashForward(爆点闪现)", () => {
  const kept = [
    { startSec: 100, endSec: 130 },
    { startSec: 140, endSec: 160 },
  ];

  it("在保留区间内围绕峰值取闪现窗(峰前铺垫+峰后余韵)", () => {
    const plan = planFlashForward([150], kept);
    expect(plan).not.toBeNull();
    expect(plan!.startSec).toBeCloseTo(150 - FLASH_LEAD_SEC, 5);
    expect(plan!.endSec).toBeCloseTo(150 + FLASH_TAIL_SEC, 5);
  });

  it("峰值贴着段边界时窗被夹取,夹到过短则跳过换下一个峰", () => {
    // 159.9 贴着段尾:窗被夹到 [159.7, 160] = 0.3s,恰好达标
    const edge = planFlashForward([159.9], kept);
    expect(edge).not.toBeNull();
    expect(edge!.endSec - edge!.startSec).toBeGreaterThanOrEqual(FLASH_MIN_SEC - 1e-6);
    // 100.02 贴着段头:窗 [100, 100.52];140.01 贴段头同理——都合法
    // 峰值不在任何保留区间(135 落在空隙里)→ 跳过它选下一个
    const skipGap = planFlashForward([135, 150], kept);
    expect(skipGap!.startSec).toBeCloseTo(150 - FLASH_LEAD_SEC, 5);
  });

  it("无可用峰值返回 null(宁可不做不可做错)", () => {
    expect(planFlashForward([], kept)).toBeNull();
    expect(planFlashForward([135], kept)).toBeNull(); // 全部落在空隙
  });
});

describe("missingHookPayoffs(钩子兑付校验)", () => {
  it("钩子承诺的数字必须出现在转写里,缺了报出来", () => {
    const missing = missingHookPayoffs("只要99块,省下3000元", "今天这个只要九十九,能给你省下3000元");
    expect(missing).toEqual(["99"]); // 3000 在片中;99 被转写成汉字→报缺
  });

  it("转写里的千分位/空格分隔不影响匹配", () => {
    expect(missingHookPayoffs("直降1999元", "直接给你降 1,999 元")).toEqual([]);
  });

  it("单位数不核对(常被转写成汉字,必然误报)", () => {
    expect(missingHookPayoffs("3个方法", "三个方法教给你")).toEqual([]);
  });

  it("百分比/折扣类承诺按数字核匹配", () => {
    expect(missingHookPayoffs("打4.9折,便宜30%", "四点九折,便宜30个点")).toEqual(["4.9折"]);
  });

  it("无钩子/无转写时不评估", () => {
    expect(missingHookPayoffs(undefined, "随便说点什么")).toEqual([]);
    expect(missingHookPayoffs("只要99块", undefined)).toEqual([]);
  });
});
