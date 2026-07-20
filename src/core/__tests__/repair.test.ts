import { describe, it, expect } from "vitest";
import { planRepair, buildRepairArgs, type RepairContext } from "../repair";
import type { ClipQaReport } from "../qa";

/** 干净报告底座,各用例往上叠告警。 */
const baseReport = (over: Partial<ClipQaReport> = {}): ClipQaReport => ({
  status: "warn",
  issues: ["占位告警"],
  durationSec: 30,
  expectedDurationSec: 30,
  blackSpans: [],
  silenceSpans: [],
  loudness: { integratedLufs: -14, truePeakDb: -1.5 },
  midWordCuts: 0,
  contentHits: null,
  ...over,
});

const ctx = (over: Partial<RepairContext> = {}): RepairContext => ({
  normalizeLoudness: true,
  headTrimmable: true,
  ...over,
});

describe("planRepair (修复计划推导)", () => {
  it("贴片尾的长静音 → 裁尾(留 0.25s 呼吸垫)", () => {
    const plan = planRepair(baseReport({ silenceSpans: [{ startSec: 27.5, endSec: 30 }] }), ctx());
    expect(plan).not.toBeNull();
    expect(plan!.trimEndSec).toBeCloseTo(27.75);
    expect(plan!.trimStartSec).toBe(0);
    expect(plan!.trimmedSec).toBeCloseTo(2.25);
    expect(plan!.actions[0]).toContain("裁掉结尾");
  });

  it("贴片头的长静音 → 裁头;高潮前置(headTrimmable=false)不动头", () => {
    const report = baseReport({ silenceSpans: [{ startSec: 0, endSec: 3 }] });
    const plan = planRepair(report, ctx());
    expect(plan!.trimStartSec).toBeCloseTo(2.75);
    expect(planRepair(report, ctx({ headTrimmable: false }))).toBeNull();
  });

  it("片头黑屏整段裁掉(不留垫)", () => {
    const plan = planRepair(baseReport({ blackSpans: [{ startSec: 0, endSec: 1.2 }] }), ctx());
    expect(plan!.trimStartSec).toBeCloseTo(1.2);
  });

  it("片中静音/黑屏是内容取舍,不裁", () => {
    expect(planRepair(baseReport({ silenceSpans: [{ startSec: 10, endSec: 14 }] }), ctx())).toBeNull();
    expect(planRepair(baseReport({ blackSpans: [{ startSec: 12, endSec: 13 }] }), ctx())).toBeNull();
  });

  it("裁量低于下限(0.4s)不值得重编码 → 不裁", () => {
    expect(planRepair(baseReport({ silenceSpans: [{ startSec: 0, endSec: 0.5 }] }), ctx())).toBeNull();
  });

  it("裁过头守卫:修复后保留过半才裁,否则放弃裁剪", () => {
    const report = baseReport({
      durationSec: 10,
      silenceSpans: [
        { startSec: 0, endSec: 4 },
        { startSec: 6.5, endSec: 10 },
      ],
    });
    expect(planRepair(report, ctx())).toBeNull();
  });

  it("响度偏离/真峰值超限 → 二遍归一;没开响度标准化不修", () => {
    const off = baseReport({ loudness: { integratedLufs: -18, truePeakDb: -2 } });
    expect(planRepair(off, ctx())!.loudness).toBe(true);
    expect(planRepair(off, ctx({ normalizeLoudness: false }))).toBeNull();
    const peak = baseReport({ loudness: { integratedLufs: -14, truePeakDb: -0.2 } });
    expect(planRepair(peak, ctx())!.loudness).toBe(true);
  });

  it("没有可自愈项(如只有半词告警)返回 null", () => {
    expect(planRepair(baseReport({ midWordCuts: 2 }), ctx())).toBeNull();
  });
});

describe("buildRepairArgs (修复参数)", () => {
  it("仅响度:视频流复制 + loudnorm,秒级零画质损失", () => {
    const plan = { loudness: true, trimStartSec: 0, trimEndSec: null, trimmedSec: 0, actions: [] };
    const args = buildRepairArgs("in.mp4", "out.mp4", plan, 30);
    expect(args).toContain("copy");
    expect(args.join(" ")).toContain("loudnorm");
    expect(args).not.toContain("-ss");
    expect(args).not.toContain("libx264");
  });

  it("裁边:帧精确重编码 + 新边界 30ms 淡化", () => {
    const plan = { loudness: false, trimStartSec: 2.75, trimEndSec: 27.75, trimmedSec: 5, actions: [] };
    const args = buildRepairArgs("in.mp4", "out.mp4", plan, 30);
    expect(args).toContain("libx264");
    expect(args[args.indexOf("-ss") + 1]).toBe("00:00:02.750");
    expect(args[args.indexOf("-t") + 1]).toBe("00:00:25.000");
    expect(args.join(" ")).toContain("afade=t=in");
    expect(args.join(" ")).not.toContain("loudnorm");
  });

  it("裁边 + 响度可以一遍完成,loudnorm 在淡化之前", () => {
    const plan = { loudness: true, trimStartSec: 0, trimEndSec: 27, trimmedSec: 3, actions: [] };
    const args = buildRepairArgs("in.mp4", "out.mp4", plan, 30);
    const af = args[args.indexOf("-af") + 1];
    expect(af.indexOf("loudnorm")).toBeGreaterThanOrEqual(0);
    expect(af.indexOf("loudnorm")).toBeLessThan(af.indexOf("afade"));
  });
});
