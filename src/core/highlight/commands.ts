/**
 * 主播口令打点(voice-activated clipping,2026 切片工具新趋势):主播在直播里
 * 亲口说「这段剪下来 / 切片君记一下 / clip that」,等于他本人实时认证了一个
 * 爆点——这是所有信号里最直接的一路人工标注,零成本(纯文本扫描,不跑模型)。
 *
 * ⚠ 口令和观众笑声一样是「滞后标记」:要剪的内容发生在口令**之前**。
 * 这里只负责找到口令出现的时刻;怎么往前找内容由提示词交代给 LLM
 * (见 prompt.ts renderSignals 的 clipCommandMarks 段)。
 *
 * 纯函数,可单测。误报的代价很低(只是提示词里多一行证据,LLM 仍会核对
 * 前文内容),所以模式取「宁可稍宽」;但对高频日常语(切换/这段时间)做了
 * 负向排除,不至于满屏假口令。
 */
import type { Transcript } from "../transcribe/types";

/** 两个口令的最小间隔:同一句话被断成几段时只记一次。 */
export const COMMAND_MIN_GAP_SEC = 20;
/** 口令上限:超过说明是误报刷屏(或主播口头禅),截断防提示词爆量。 */
export const COMMAND_MAX_MARKS = 12;

/**
 * 中文口令模式:
 *  1. 指代 + 剪/切:「(把)这段/刚才那段 …… 剪/切」——排除「这段时间/日子/经历/感情」
 *     等日常搭配,排除「切换/切入」类动词;
 *  2. 剪/切 + 完成补语:「剪下来/切出来/剪个切片」——不含「剪一下/切一下」
 *     (切一下水果类误报太多,真口令几乎都带指代,走第 1 条就能中);
 *  3. 祈使前缀 + 剪/切:「记得/帮我/给我/待会/回头/后期/剪辑组/切片君 …… 剪/切」。
 * 英文口令:clip that / clip this / clip it / that's a clip / someone clip …
 */
const ZH_PATTERNS: RegExp[] = [
  /(?:把)?(?:这段|这一段|刚才那段|刚刚那段|刚那段)(?!时间|日子|经历|感情|关系)[^。！？!?]{0,8}?[剪切](?![换磋入])/,
  /[剪切](?:下来|出来|个切片|个片段|成切片)/,
  /(?:记得|帮我|给我|待会儿?|回头|后期|剪辑组|切片君)[^。！？!?]{0,6}?[剪切](?![换磋入])/,
];

const EN_PATTERNS: RegExp[] = [
  /\bclip\s+(?:that|this|it)\b/i,
  /\b(?:that|this)(?:'s|\s+is)\s+(?:a\s+)?clip\b/i,
  /\bsomeone\s+clip\b/i,
];

/** 一句话是否命中剪辑口令。 */
export function isClipCommand(text: string): boolean {
  if (!text) return false;
  return ZH_PATTERNS.some((p) => p.test(text)) || EN_PATTERNS.some((p) => p.test(text));
}

/**
 * 全稿扫描口令时刻:返回命中句的开始时间(升序),近距离命中去重、总量截断。
 */
export function detectClipCommands(transcript: Transcript): number[] {
  const marks: number[] = [];
  for (const seg of transcript.segments) {
    if (!isClipCommand(seg.text)) continue;
    const last = marks[marks.length - 1];
    if (last !== undefined && seg.startSec - last < COMMAND_MIN_GAP_SEC) continue;
    marks.push(seg.startSec);
    if (marks.length >= COMMAND_MAX_MARKS) break;
  }
  return marks;
}
