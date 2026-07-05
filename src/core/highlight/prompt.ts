/**
 * Highlight-detection prompts: the LLM reads a timestamped transcript and
 * nominates clip-worthy selections BY QUOTING TEXT — it never invents
 * timestamps (they are reverse-matched later).
 *
 * Bilingual by design: Chinese transcripts get the zh prompt, everything else
 * gets the en prompt, and titles/hooks/reasons always follow the transcript's
 * own language. Pure builders, testable.
 */
import type { Transcript } from "../transcribe/types";

export const HIGHLIGHT_SYSTEM_PROMPT_ZH = `你是一位顶级短视频切片操盘手。给你一份长视频的逐句稿,你要从中挑出最可能在抖音/快手/B站/TikTok 上爆的片段。

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

export const HIGHLIGHT_SYSTEM_PROMPT_EN = `You are a top short-form clipping strategist. Given the sentence-level transcript of a long video, pick the segments most likely to go viral on TikTok / Reels / Shorts.

【What makes a clip viral】
- Strong hook opening: counterintuitive takes, conflict, suspenseful questions, striking numbers, emotional peaks
- Self-contained: the clip makes sense without outside context, with a clear arc
- High value density: quotables, actionable insight, fail/twist moments, raw emotion, punchlines
- Length 8–40 seconds (roughly 2–8 transcript sentences); it MUST open on the hook line, never a slow build-up

【Hard rules】
1. Select ONLY from the transcript verbatim: quoteStart/quoteEnd must be copied character-for-character (punctuation included) — never paraphrase, never invent
2. quoteStart = the opening words of the clip's first sentence (≥6 words/characters); quoteEnd = the closing words of its last sentence (≥6 words/characters)
3. startSegmentId/endSegmentId are the [id] of the clip's first and last sentences
4. NEVER output timestamps — the system reverse-matches your quotes; you only pick content
5. Clips must not overlap; quality over quantity — do not force weak picks
6. Write title/hook/reason in the SAME language as the transcript`;

/** zh when the engine says so or the text itself is CJK-dominant. */
export function isChineseTranscript(transcript: Transcript): boolean {
  const lang = transcript.language.toLowerCase();
  if (lang.startsWith("zh") || lang.startsWith("yue")) return true;
  if (lang && lang !== "auto") return false;
  const sample = transcript.segments
    .slice(0, 10)
    .map((s) => s.text)
    .join("");
  const cjk = (sample.match(/[一-鿿]/g) ?? []).length;
  return sample.length > 0 && cjk / sample.length > 0.3;
}

export function highlightSystemPrompt(transcript: Transcript): string {
  return isChineseTranscript(transcript) ? HIGHLIGHT_SYSTEM_PROMPT_ZH : HIGHLIGHT_SYSTEM_PROMPT_EN;
}

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

const OUTPUT_SHAPE = `{
  "clips": [
    {
      "title": "...",
      "hook": "...",
      "score": 85,
      "reason": "...",
      "startSegmentId": 3,
      "endSegmentId": 6,
      "quoteStart": "...",
      "quoteEnd": "...",
      "keywords": ["...", "..."]
    }
  ]
}`;

export function buildHighlightPrompt(transcript: Transcript, maxClips = 6): string {
  if (isChineseTranscript(transcript)) {
    return `请从下面的逐句稿中挑出最多 ${maxClips} 个最有爆款潜质的片段。

【逐句稿】(格式: [句id] 开始时间 内容)
${renderTranscriptLines(transcript)}

【输出格式】严格输出 JSON,不要任何多余文字:
${OUTPUT_SHAPE}

字段说明:title=适合发布的短标题(≤20字);hook=开头钩子句原文;score=0-100 相对排序分;reason=一句话为什么能爆;quoteStart/quoteEnd=片段首句开头/末句结尾的逐字原文;keywords=该片段里 3-5 个最有冲击力的词,必须逐字取自片段原文(用于字幕划重点)。
要求:按 score 从高到低排;片段互不重叠。`;
  }
  return `Pick at most ${maxClips} clip candidates with the highest viral potential from the transcript below.

【Transcript】(format: [sentenceId] startTime text)
${renderTranscriptLines(transcript)}

【Output format】Respond with STRICT JSON only, no extra text:
${OUTPUT_SHAPE}

Fields: title = a post-ready short title (≤ 12 words); hook = the verbatim opening hook line; score = 0-100 relative ranking; reason = one line on why it can go viral; quoteStart/quoteEnd = verbatim opening/closing words of the clip; keywords = the 3-5 punchiest words/phrases inside the clip, copied verbatim (used to emphasize caption keywords).
Sort by score descending; clips must not overlap.`;
}

/** Extract the first JSON object/array from LLM output (handles \`\`\`json fences). */
export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenced) return fenced[1].trim();
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) return brace[0].trim();
  return text.trim();
}

// ---------- Stage 2: adversarial review ----------

export const REVIEW_SYSTEM_PROMPT_ZH = `你是一位极其严格的短视频内容评审。给你若干条已切好的候选片段,你从「刷到这条视频的陌生观众」视角盲评每一条:
- 钩子:前 3 秒(第一句)能不能让人停下滑动?平淡开场直接不及格
- 完整:是不是断章取义?开头是否像半截话、结尾有没有收住?
- 独立:不看原视频,这条能不能看懂、有没有信息量或情绪价值?
你要敢于否决:平庸、凑数、需要上下文才能懂的片段,一律 keep=false。这是发布前的最后一道质量门,放水的代价是账号发废片。`;

export const REVIEW_SYSTEM_PROMPT_EN = `You are a ruthless short-form content reviewer. You receive pre-cut clip candidates and judge each one blind, as a stranger scrolling past:
- Hook: does the FIRST line stop the scroll within 3 seconds? Flat openings fail.
- Complete: is it quote-mined? Does it start mid-thought or end without landing?
- Standalone: without the source video, is it understandable and worth watching?
Reject freely: mediocre, filler, or context-dependent clips get keep=false. You are the final quality gate before publishing — letting weak clips through burns the channel.`;

export function reviewSystemPrompt(transcript: Transcript): string {
  return isChineseTranscript(transcript) ? REVIEW_SYSTEM_PROMPT_ZH : REVIEW_SYSTEM_PROMPT_EN;
}

const REVIEW_SHAPE = `{
  "reviews": [
    { "id": 1, "keep": true, "score": 85, "note": "..." }
  ]
}`;

interface ReviewableClip {
  id: number;
  title: string;
  startSec: number;
  endSec: number;
  text: string;
}

/** One sentence of context on each side, so the reviewer can spot quote-mining. */
function contextAround(transcript: Transcript, startSec: number, endSec: number): { before: string; after: string } {
  const segs = transcript.segments;
  const firstIdx = segs.findIndex((s) => s.endSec > startSec);
  const lastIdx = segs.findLastIndex((s) => s.startSec < endSec);
  return {
    before: firstIdx > 0 ? segs[firstIdx - 1].text : "",
    after: lastIdx >= 0 && lastIdx + 1 < segs.length ? segs[lastIdx + 1].text : "",
  };
}

export function buildReviewPrompt(transcript: Transcript, clips: ReviewableClip[]): string {
  const zh = isChineseTranscript(transcript);
  const blocks = clips
    .map((c) => {
      const ctx = contextAround(transcript, c.startSec, c.endSec);
      const dur = Math.round(c.endSec - c.startSec);
      return zh
        ? `【候选 ${c.id}】《${c.title}》 时长${dur}秒\n前文:${ctx.before || "(无)"}\n片段:${c.text}\n后文:${ctx.after || "(无)"}`
        : `【Candidate ${c.id}】"${c.title}" ${dur}s\nBefore: ${ctx.before || "(none)"}\nClip: ${c.text}\nAfter: ${ctx.after || "(none)"}`;
    })
    .join("\n\n");
  return zh
    ? `逐条盲评下面的候选片段。score=0-100 重新打分(横向比较);keep=false 表示不建议发布;note=一句话评语(不推荐时必须说清原因)。\n\n${blocks}\n\n【输出格式】严格输出 JSON,不要任何多余文字:\n${REVIEW_SHAPE}`
    : `Blind-review each candidate below. Re-score 0-100 (relative); keep=false means do not publish; note = one-line verdict (mandatory when rejecting).\n\n${blocks}\n\n【Output format】STRICT JSON only:\n${REVIEW_SHAPE}`;
}
