/**
 * 质量门规则层(v0.13):在 LLM 复评之外,用确定性规则抓「一眼硬伤」——
 * 开头悬空接续词(所以/但是……=半截话)、结尾没收住(逗号/顿号收尾)、
 * 多人抢话密集(说话人切换频率超阈值,AI 选段在对谈场景命中率只有 4/10)。
 *
 * 三轮调研结论:AI 出片 30-45% 是废片,而 2026 年发废片的代价是账号级的
 * (慢推流 7 天评估/频道分发上限)。质量门的职责是把「选出」和「选完」分开:
 * publish=建议发 / review=需人审 / drop=不建议发。
 *
 * 规则层只降档不升档、只到 review 不到 drop(fail-open:规则误判的代价
 * 必须小)。drop 只能由 LLM 复评给出。纯函数,可单测。
 */
import type { Transcript } from "../transcribe/types";
import type { HighlightCandidate } from "../../shared/api-types";
import { clipDurationSec } from "../../shared/pieces";

/** 质量门档位:建议发 / 需人审 / 不建议发。 */
export type GateTier = "publish" | "review" | "drop";

/**
 * 悬空接续词:出现在片段第一句开头,说明上一句被切掉了、观众听着像半截话。
 * 只收「几乎不可能是完整开场」的词——「其实/说白了」这类反而是常见的
 * 金句开头,不能进清单。
 */
const DANGLING_OPENERS_ZH = [
  "所以说",
  "所以",
  "但是",
  "但就是",
  "然后呢",
  "然后",
  "而且",
  "并且",
  "不过",
  "可是",
  "否则",
  "要不然",
  "于是",
  "接着",
  "还有就是",
  "另外",
  "总之",
  "综上",
];

const DANGLING_OPENER_EN = /^(?:so|but|and|then|also|because|however|anyway|therefore)\b/i;

/** 开头是不是悬空的半截话。 */
export function openingDangles(text: string): boolean {
  const t = text.trim().replace(/^[「『"'“‘(\(\[]+/, "");
  if (!t) return false;
  if (DANGLING_OPENER_EN.test(t)) return true;
  return DANGLING_OPENERS_ZH.some((w) => t.startsWith(w));
}

/**
 * 结尾没收住:以逗号/顿号/冒号/分号/破折号结尾 = 明显话没说完。
 * 只抓硬伤——「无标点结尾」不算(ASR 丢句尾标点太常见,误报会刷屏)。
 */
export function endingUnfinished(text: string): boolean {
  const t = text.trim().replace(/[」』"'”’)\)\]]+$/, "");
  if (!t) return false;
  return /[，,、：:;；—–-]$/.test(t);
}

/** 说话人切换密度阈值(次/分钟):超过就是抢话/碎片对谈,单独看大概率听不懂。 */
export const SPEAKER_TANGLE_PER_MIN = 10;

/**
 * 多人抢话密集:候选范围内说话人切换次数按分钟折算超阈值。
 * 只在真的做过说话人分离(≥2 人)时才有意义;单说话人/未分离一律 false。
 */
export function speakerTangled(
  transcript: Transcript,
  candidate: Pick<HighlightCandidate, "startSec" | "endSec" | "pieces">
): boolean {
  const ranges =
    candidate.pieces && candidate.pieces.length > 1
      ? candidate.pieces
      : [{ startSec: candidate.startSec, endSec: candidate.endSec }];
  let switches = 0;
  let prev: number | undefined;
  let sawSpeaker = false;
  const speakers = new Set<number>();
  for (const r of ranges) {
    for (const s of transcript.segments) {
      if (s.endSec <= r.startSec || s.startSec >= r.endSec) continue;
      if (s.speaker === undefined) continue;
      sawSpeaker = true;
      speakers.add(s.speaker);
      if (prev !== undefined && s.speaker !== prev) switches++;
      prev = s.speaker;
    }
  }
  if (!sawSpeaker || speakers.size < 2) return false;
  const durMin = Math.max(1 / 60, clipDurationSec(candidate) / 60);
  return switches / durMin > SPEAKER_TANGLE_PER_MIN;
}

/** 单条候选的规则层检查结果(zh 决定给用户看的原因文案语言)。 */
export function ruleGateIssues(
  transcript: Transcript,
  candidate: HighlightCandidate,
  zh: boolean
): string[] {
  // 信号候选(跳舞/萌宠等)不是按原话切的,文本规则对它没有意义
  if (candidate.boundary === "signal") return [];
  const issues: string[] = [];
  if (openingDangles(candidate.text)) {
    issues.push(zh ? "开头像半截话(悬空接续词)" : "opens mid-thought (dangling connective)");
  }
  if (endingUnfinished(candidate.text)) {
    issues.push(zh ? "结尾没收住(截在逗号上)" : "ends unfinished (cut on a comma)");
  }
  if (speakerTangled(transcript, candidate)) {
    issues.push(zh ? "多人抢话密集,单独看可能听不懂" : "dense speaker overlap, may not stand alone");
  }
  return issues;
}

/**
 * 把规则层结论并进候选:
 * - 有硬伤且当前是 publish(或 LLM 复评没跑,gate 缺省)→ 降为 review;
 * - 绝不升档、绝不给 drop(drop 只能由 LLM 复评判);
 * - 原因追加进 gateNotes(证据链给人看)。
 */
export function applyRuleGate(
  transcript: Transcript,
  candidates: HighlightCandidate[],
  zh: boolean
): HighlightCandidate[] {
  return candidates.map((c) => {
    const issues = ruleGateIssues(transcript, c, zh);
    if (issues.length === 0) return c;
    const demote = c.gate === "publish" || c.gate === undefined;
    return {
      ...c,
      gate: demote ? "review" : c.gate,
      // 需人审不等于不推荐导出;recommended 只跟 LLM 的 keep/verdict 走,
      // 规则降档只影响 UI 档位与提示,不静默改变选中状态之外的行为
      gateNotes: [...(c.gateNotes ?? []), ...issues],
    };
  });
}
