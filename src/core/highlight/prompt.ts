/**
 * Highlight-detection prompt: the LLM reads a timestamped transcript and
 * nominates clip-worthy selections BY QUOTING TEXT — it never invents
 * timestamps (they are reverse-matched later). Pure builders, testable.
 */
import type { Transcript } from "../transcribe/types";

export const HIGHLIGHT_SYSTEM_PROMPT = `你是一位顶级短视频切片操盘手。给你一份长视频的逐句稿,你要从中挑出最可能在抖音/快手/B站/TikTok 上爆的片段。

【什么样的片段能爆】
- 强钩子开场:反常识观点、冲突、悬念提问、惊人数字、情绪爆发
- 完整表达:片段自成一体,离开上下文也能看懂,有起有收
- 高价值密度:金句、干货、翻车/反转瞬间、真情实感、抖包袱
- 时长 8~40 秒(对应逐句稿里约 2~8 句),开头一定要是钩子句,不要慢热铺垫

【铁律】
1. 只能从逐句稿原文里选,quoteStart/quoteEnd 必须逐字照抄原文(含标点),绝不改写、绝不自己编
2. quoteStart = 片段第一句的开头原文(≥6个字/词);quoteEnd = 片段最后一句的结尾原文(≥6个字/词)
3. startSegmentId/endSegmentId 填片段起止句的 [id]
4. 不要输出时间戳——时间由系统按原文反查,你只负责挑内容
5. 片段之间不要重叠;宁缺毋滥,没有爆点潜质的内容不要硬凑
6. title/hook/reason 用逐句稿同款语言写`;

/** Render transcript segments as "[id] MM:SS text" lines the LLM can cite. */
export function renderTranscriptLines(transcript: Transcript): string {
  return transcript.segments
    .map((s) => {
      const m = Math.floor(s.startSec / 60);
      const sec = Math.floor(s.startSec % 60);
      const clock = `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
      return `[${s.id}] ${clock} ${s.text}`;
    })
    .join("\n");
}

export function buildHighlightPrompt(transcript: Transcript, maxClips = 6): string {
  return `请从下面的逐句稿中挑出最多 ${maxClips} 个最有爆款潜质的片段。

【逐句稿】(格式: [句id] 开始时间 内容)
${renderTranscriptLines(transcript)}

【输出格式】严格输出 JSON,不要任何多余文字:
{
  "clips": [
    {
      "title": "适合发布的短标题(≤20字)",
      "hook": "这条切片开头的钩子句(原文)",
      "score": 85,
      "reason": "一句话:为什么这段能爆(钩子/金句/冲突/干货…)",
      "startSegmentId": 3,
      "endSegmentId": 6,
      "quoteStart": "片段第一句开头的逐字原文",
      "quoteEnd": "片段最后一句结尾的逐字原文"
    }
  ]
}

要求:score 是 0-100 的相对排序分;按 score 从高到低排;片段互不重叠。`;
}

/** Extract the first JSON object/array from LLM output (handles \`\`\`json fences). */
export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenced) return fenced[1].trim();
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) return brace[0].trim();
  return text.trim();
}
