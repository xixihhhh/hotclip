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
import type { MediaSignals } from "../signals";

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

/** True when the transcript carries diarization with more than one speaker. */
export function isMultiSpeaker(transcript: Transcript): boolean {
  const ids = new Set<number>();
  for (const s of transcript.segments) if (s.speaker !== undefined) ids.add(s.speaker);
  return ids.size > 1;
}

/**
 * Render transcript segments as "[id] MM:SS text" lines the LLM can cite.
 * When diarized, each line is prefixed with the speaker ("S1:") so the LLM can
 * attribute quotes and avoid stitching two speakers into one "highlight".
 */
export function renderTranscriptLines(transcript: Transcript): string {
  const multi = isMultiSpeaker(transcript);
  return transcript.segments
    .map((s) => {
      const m = Math.floor(s.startSec / 60);
      const sec = Math.floor(s.startSec % 60);
      const clock = `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
      const spk = multi && s.speaker !== undefined ? `S${s.speaker + 1}: ` : "";
      return `[${s.id}] ${clock} ${spk}${s.text}`;
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

function fmtClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const ss = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/** Render Tier-0 audiovisual evidence for prompt injection ("" when empty). */
export function renderSignals(signals: MediaSignals | undefined, zh: boolean): string {
  if (!signals) return "";
  const fmt = (rs: Array<{ startSec: number; endSec: number }>): string =>
    rs.map((r) => `${fmtClock(r.startSec)}-${fmtClock(r.endSec)}`).join(", ");
  const lines: string[] = [];
  if (signals.loudPeaks.length > 0) {
    lines.push(zh ? `- 响度峰值时段(情绪爆发/笑声/喊叫): ${fmt(signals.loudPeaks)}` : `- Loudness peaks (bursts/laughter/shouting): ${fmt(signals.loudPeaks)}`);
  }
  if (signals.cutDense.length > 0) {
    lines.push(zh ? `- 镜头切换密集段(画面高能): ${fmt(signals.cutDense)}` : `- Dense scene-cut windows (visual action): ${fmt(signals.cutDense)}`);
  }
  if (signals.visualPeaks && signals.visualPeaks.length > 0) {
    lines.push(zh ? `- 视觉模型判定的画面爆点时刻(夸张表情/激烈动作/场面炸裂): ${fmt(signals.visualPeaks)}` : `- Vision-model visual peaks (expressions/action/spectacle): ${fmt(signals.visualPeaks)}`);
  }
  if (lines.length === 0) return "";
  return zh
    ? `\n【画面与声音信号】(辅助证据——与这些时段重合的内容更可能有真实的情绪/画面爆点,但仍以文本质量为准)\n${lines.join("\n")}\n`
    : `\n【Audiovisual signals】(supporting evidence — content overlapping these windows likely has real emotional/visual peaks; text quality still rules)\n${lines.join("\n")}\n`;
}

/** Multi-speaker attribution guidance, injected only when diarized ≥2 speakers. */
function speakerNote(transcript: Transcript, zh: boolean): string {
  if (!isMultiSpeaker(transcript)) return "";
  return zh
    ? `\n【多人对谈】每句前的 S1/S2… 是说话人标签。挑段时优先选「同一个人一段完整的话」;若是精彩问答,可跨说话人但要含完整的一问一答,别把两个人的半句拼成断章取义。\n`
    : `\n【Multi-speaker】The S1/S2… prefix on each line marks who is speaking. Prefer a single speaker's complete thought; for a great Q&A you may span speakers but keep the full exchange — never stitch two half-sentences into a misleading clip.\n`;
}

export function buildHighlightPrompt(transcript: Transcript, maxClips = 6, signals?: MediaSignals): string {
  if (isChineseTranscript(transcript)) {
    return `请从下面的逐句稿中挑出最多 ${maxClips} 个最有爆款潜质的片段。

【逐句稿】(格式: [句id] 开始时间 内容)
${renderTranscriptLines(transcript)}
${speakerNote(transcript, true)}${renderSignals(signals, true)}
【输出格式】严格输出 JSON,不要任何多余文字:
${OUTPUT_SHAPE}

字段说明:title=适合发布的短标题(≤20字);hook=开头钩子句原文;score=0-100 相对排序分;reason=一句话为什么能爆;quoteStart/quoteEnd=片段首句开头/末句结尾的逐字原文;keywords=该片段里 3-5 个最有冲击力的词,必须逐字取自片段原文(用于字幕划重点)。
要求:按 score 从高到低排;片段互不重叠。`;
  }
  return `Pick at most ${maxClips} clip candidates with the highest viral potential from the transcript below.

【Transcript】(format: [sentenceId] startTime text)
${renderTranscriptLines(transcript)}
${speakerNote(transcript, false)}${renderSignals(signals, false)}
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

export const REVIEW_SYSTEM_PROMPT_ZH = `你是一位极其严格的短视频内容评审。给你若干条已切好的候选片段,你从「刷到这条视频的陌生观众」视角盲评每一条,分四个维度分别打分(0-100)并各给一句话理由:
- hook 钩子:前 3 秒(第一句)能不能让人停下滑动?平淡开场直接不及格
- flow 结构:是不是断章取义?开头是否像半截话、结尾有没有收住?逻辑顺不顺?
- value 价值:不看原视频,这条有没有信息量或情绪价值?值不值得看完?
- trend 热点:话题/情绪贴不贴近当下平台上正在火的内容?
另外给每条写一个 teaser:≤15 个字的悬念句,能印在视频开头当文字钩子,要勾人但不剧透。
你要敢于否决:平庸、凑数、需要上下文才能懂的片段,一律 keep=false。这是发布前的最后一道质量门,放水的代价是账号发废片。`;

export const REVIEW_SYSTEM_PROMPT_EN = `You are a ruthless short-form content reviewer. You receive pre-cut clip candidates and judge each one blind, as a stranger scrolling past, scoring FOUR dimensions (0-100 each) with a one-line reason per dimension:
- hook: does the FIRST line stop the scroll within 3 seconds? Flat openings fail.
- flow: is it quote-mined? Does it start mid-thought or end without landing? Does it flow?
- value: without the source video, is it informative or emotionally worth watching to the end?
- trend: does the topic/emotion ride what is currently hot on the platforms?
Also write a teaser per clip: a suspense line of ≤8 words that could be printed at the top of the video as a text hook — intriguing, no spoilers.
Reject freely: mediocre, filler, or context-dependent clips get keep=false. You are the final quality gate before publishing — letting weak clips through burns the channel.`;

export function reviewSystemPrompt(transcript: Transcript): string {
  return isChineseTranscript(transcript) ? REVIEW_SYSTEM_PROMPT_ZH : REVIEW_SYSTEM_PROMPT_EN;
}

const REVIEW_SHAPE = `{
  "reviews": [
    {
      "id": 1, "keep": true,
      "hook": 82, "hookNote": "...",
      "flow": 74, "flowNote": "...",
      "value": 88, "valueNote": "...",
      "trend": 60, "trendNote": "...",
      "teaser": "...",
      "note": "..."
    }
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
    ? `逐条盲评下面的候选片段。hook/flow/value/trend 四维各 0-100 打分(横向比较)+ 各一句话理由;teaser=≤15字悬念句(勾人不剧透,逐句稿同款语言);keep=false 表示不建议发布;note=一句话总评(不推荐时必须说清原因)。\n\n${blocks}\n\n【输出格式】严格输出 JSON,不要任何多余文字:\n${REVIEW_SHAPE}`
    : `Blind-review each candidate below. Score hook/flow/value/trend 0-100 each (relative) with a one-line reason per dimension; teaser = a ≤8-word suspense line (intriguing, no spoilers, transcript language); keep=false means do not publish; note = one-line overall verdict (mandatory when rejecting).\n\n${blocks}\n\n【Output format】STRICT JSON only:\n${REVIEW_SHAPE}`;
}
