/**
 * 质量门规则层(v0.13):确定性硬伤检查——开头悬空/结尾没收住/多人抢话。
 * 铁律:只降档到 review、绝不 drop、绝不升档(fail-open,规则误判代价必须小)。
 */
import { describe, it, expect } from "vitest";
import { openingDangles, endingUnfinished, speakerTangled, ruleGateIssues, applyRuleGate } from "../highlight/gate";
import type { Transcript } from "../transcribe/types";
import type { HighlightCandidate } from "../../shared/api-types";

function cand(over: Partial<HighlightCandidate>): HighlightCandidate {
  return {
    id: 1, startSec: 0, endSec: 20, text: "完整的一句话。", title: "t", hook: "h",
    score: 90, reason: "", boundary: "exact", keywords: [], recommended: true, reviewNote: "",
    ...over,
  };
}

const EMPTY_TX: Transcript = { language: "zh", engine: "test", durationSec: 60, segments: [] };

describe("openingDangles(开头悬空)", () => {
  it("悬空接续词开头 = 半截话", () => {
    for (const s of ["所以我们就退款了。", "但是他不同意。", "然后呢就翻车了。", "而且价格还更贵。", "So we refunded it."]) {
      expect(openingDangles(s), s).toBe(true);
    }
  });
  it("正常开场不误伤(其实/说白了是常见金句开头)", () => {
    for (const s of ["其实这个东西很简单。", "你以为贵的就好吗?", "说白了就是信息差。", "90%的人都不知道这件事。", "Sochi is beautiful."]) {
      expect(openingDangles(s), s).toBe(false);
    }
  });
  it("跳过开头引号再判", () => {
    expect(openingDangles("「但是他说过不降价」")).toBe(true);
  });
});

describe("endingUnfinished(结尾没收住)", () => {
  it("逗号/顿号/冒号收尾 = 话没说完", () => {
    for (const s of ["我们先看第一个,", "包括材质、", "原因有三:", "so we tried,"]) {
      expect(endingUnfinished(s), s).toBe(true);
    }
  });
  it("正常收尾与无标点收尾都不算(ASR 丢句尾标点太常见)", () => {
    for (const s of ["这就是全部真相。", "你敢信?", "太值了!", "就这样定了"]) {
      expect(endingUnfinished(s), s).toBe(false);
    }
  });
});

describe("speakerTangled(多人抢话)", () => {
  const seg = (id: number, startSec: number, speaker: number): Transcript["segments"][number] => ({
    id, startSec, endSec: startSec + 2, text: "话", words: [], speaker,
  });
  it("切换密度超阈值才算(20 秒内 8 次切换 = 24 次/分钟)", () => {
    const tangled: Transcript = {
      ...EMPTY_TX,
      segments: Array.from({ length: 9 }, (_, i) => seg(i + 1, i * 2.2, i % 2)),
    };
    expect(speakerTangled(tangled, { startSec: 0, endSec: 20 })).toBe(true);
  });
  it("单说话人/未分离一律 false", () => {
    const single: Transcript = { ...EMPTY_TX, segments: Array.from({ length: 9 }, (_, i) => seg(i + 1, i * 2.2, 0)) };
    const unlabeled: Transcript = {
      ...EMPTY_TX,
      segments: Array.from({ length: 9 }, (_, i) => ({ ...seg(i + 1, i * 2.2, 0), speaker: undefined })),
    };
    expect(speakerTangled(single, { startSec: 0, endSec: 20 })).toBe(false);
    expect(speakerTangled(unlabeled, { startSec: 0, endSec: 20 })).toBe(false);
  });
  it("正常一问一答不误伤(60 秒 4 次切换)", () => {
    const qa: Transcript = {
      ...EMPTY_TX,
      segments: Array.from({ length: 5 }, (_, i) => seg(i + 1, i * 12, i % 2)),
    };
    expect(speakerTangled(qa, { startSec: 0, endSec: 60 })).toBe(false);
  });
});

describe("ruleGateIssues / applyRuleGate", () => {
  it("信号候选跳过文本规则(它不是按原话切的)", () => {
    expect(ruleGateIssues(EMPTY_TX, cand({ boundary: "signal", text: "但是," }), true)).toEqual([]);
  });

  it("publish/缺省降为 review 并写明原因;review 原因追加;drop 不动档", () => {
    const bad = "但是这个东西呢,";
    const out = applyRuleGate(EMPTY_TX, [
      cand({ id: 1, text: bad, gate: "publish" }),
      cand({ id: 2, text: bad }), // 复评没跑,gate 缺省
      cand({ id: 3, text: bad, gate: "drop", gateNotes: ["凑数"] }),
      cand({ id: 4, text: "完整的一句话。", gate: "publish" }),
    ], true);
    expect(out[0].gate).toBe("review");
    expect(out[0].gateNotes).toEqual(["开头像半截话(悬空接续词)", "结尾没收住(截在逗号上)"]);
    expect(out[1].gate).toBe("review");
    expect(out[2].gate).toBe("drop"); // 绝不升档
    expect(out[2].gateNotes).toEqual(["凑数", "开头像半截话(悬空接续词)", "结尾没收住(截在逗号上)"]);
    expect(out[3].gate).toBe("publish");
    expect(out[3].gateNotes).toBeUndefined();
  });

  it("规则降档不改变 recommended(选中状态只跟 LLM 复评走)", () => {
    const out = applyRuleGate(EMPTY_TX, [cand({ text: "但是这样,", gate: "publish", recommended: true })], true);
    expect(out[0].recommended).toBe(true);
  });
});
