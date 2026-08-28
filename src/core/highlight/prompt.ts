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
import type { ClipLength } from "../../shared/api-types";
import type { MediaSignals } from "../signals";
import { referencePromptSection, type ReferenceProfile } from "../reference";
import { reviewMemorySection, type ReviewRecord } from "../review-memory";
import { performanceMemorySection, type PerformanceEntry } from "../performance-memory";
import { genreSection } from "../genre";
import { clipDurationSec, isStitched, type ClipPiece } from "../../shared/pieces";

export const HIGHLIGHT_SYSTEM_PROMPT_ZH = `你是一位顶级短视频切片操盘手。给你一份长视频的逐句稿,你要从中挑出最可能在抖音/快手/B站/TikTok 上爆的片段。

【先记住:能爆的内容极其稀缺】
一场两小时的直播,真正值得剪的通常不到五分钟。绝大多数内容都是平淡的过场。宁可只给两三条真爆点,也不要为凑数把平庸内容包装成爆点——凑数的片段发出去会拉垮整个账号。

【动手前先判断这是什么内容,再决定信哪路证据】
素材可能是带货直播、游戏直播、才艺/跳舞、聊天连麦、讲课、户外探店、访谈播客、赛事解说、开箱评测……不同类型的爆点位置完全不同,先自己判断,再按下面的权重去找:
- **话里有内容的**(带货/讲课/访谈/解说/评测):爆点在说了什么,以文字稿为主判断
- **靠反应的**(游戏/聊天/户外/赛事):精彩瞬间的文字常常只有"卧槽/我去/没了"几个字,毫无信息量。这类要重点看语气激动时段和弹幕峰值,文字稿只用来确认发生了什么
- **靠画面的**(才艺/跳舞/唱歌/风景):文字稿基本是空的,别因为某句话"读起来还行"就选它——那不是观众看的东西。以画面高能时段、音乐节奏和弹幕为主
判断不了就按"话里有内容"处理,但别把明显没信息量的口水话当金句。

【按爆款概率从高到低找这些时刻】
1. 前后打脸/自相矛盾:同一个人前面一套后面一套——刚说"绝不降价"转头就降价、先吹爆再拆台、承诺和后来做的对不上、双标。这类反差是最强的爆点,值得从相隔很远的两处内容里挖
2. 冲突与尖锐:被问到不想回答的问题、当场反驳别人、翻车、意外状况、真吵起来
3. 反常识金句:一句话颠覆认知("越努力越穷"这种),脱离上下文也能独立传播
4. 情绪顶点:讲到激动处、破防、真情流露、突然低落——语气本身就是内容
5. 笑点:必须是完整的「铺垫→包袱」结构。光有观众在笑、却没有那句抖出来的包袱,绝对不要选
6. 硬核干货:让人想收藏的方法/清单/具体数字(平台现在收藏权重最高)
7. 带货场景专属:产品出现意外效果、价格揭晓的那一下、真实试用翻车、被追问成分/售后

【开头第一句就是生死线】
片段的第一句必须自带钩子。能停住手指的句式:
- 反常识/打脸型(停留力最强):"你以为X其实Y"、"别再信X了"、"真正的X不是Y"、"越X越Y"
- 结果反差型:"我X个月做到了Y"、"从X到Y"、"没想到X"
- 悬念型:"我发现了一个秘密"、"千万不要X"、"这就是为什么X"
- 痛点型:"你是不是也X"、"90%的人不知道X"
寒暄、自我介绍、"接下来我们看下一个"、慢热铺垫——一律不能当片段开头。

【长度】
时长 8~40 秒(对应逐句稿里约 2~8 句)。

【多片段拼接:两处内容隔得远,就必须用 parts】
绝大多数切片是一段连续内容,直接用 quoteStart/quoteEnd 就够了。
但只要你想选的两处内容**中间隔着一大段无关的话**(第 1 类「前后打脸」几乎总是这样:立誓在开头,打脸在十几分钟后),就**必须**输出 parts 把它们分别框出来。
⚠ 这一步不是可选的:此时如果你只给 startSegmentId=前面那句、endSegmentId=后面那句,系统会把中间那一大段全部剪进成片——时长直接超标,这条候选会被丢掉,你挑出的爆点等于白挑。
parts 的写法:
- 按原视频时间先后列 2~3 段,每段自带 quoteStart/quoteEnd 和句 id;parts 的顺序就是成片播放顺序,不能倒放
- 每段都要是完整、没被掐断的一句以上的话(至少 2 秒);各段时长加起来仍要满足上面的长度要求(跨度多长不算数,只算真正剪进去的)
- 用了 parts 时顶层字段照填:startSegmentId/quoteStart 填第一段的开头,endSegmentId/quoteEnd 填最后一段的结尾
- 拼接绝不能制造原话里没有的意思——这是最容易翻车的地方。两段中间如果隔着"但是/不过"之类的转折,或者后一段其实是在说别的事,就不要拼,这条干脆别选;不确定就老老实实切一段连续的

【铁律】
1. 只能从逐句稿原文里选,quoteStart/quoteEnd 必须逐字照抄原文(含标点),绝不改写、绝不自己编
2. quoteStart = 片段第一句的开头原文(≥6个字/词);quoteEnd = 片段最后一句的结尾原文(≥6个字/词)
3. startSegmentId/endSegmentId 必须填逐句稿里**真实存在的那两个 [id] 数字**(如首句是 [21] 就填 21),绝不能填 -1、0 或留空;score 必须是 0-100 的整数,同样不能填 -1
4. 不要输出「时:分:秒」这类时间戳——时间由系统按你抄的原文反查;但上面那两个句 id 和 score 是必填的,别一起省掉
5. 片段之间不要重叠;宁缺毋滥,没有爆点潜质的内容不要硬凑
6. 不能断章取义:剪出来的意思必须和原话一致。靠掐掉半句制造的"爆点"会反噬账号,一律不要
7. title/hook/reason 用逐句稿同款语言写`;

export const HIGHLIGHT_SYSTEM_PROMPT_EN = `You are a top short-form clipping strategist. Given the sentence-level transcript of a long video, pick the segments most likely to go viral on TikTok / Reels / Shorts.

【Viral material is RARE】
In a two-hour stream, under five minutes is usually worth clipping. Most of it is filler. Returning two or three genuine hits beats padding the list — weak clips published to a channel drag the whole account down.

【First work out what this footage IS, then decide which evidence to trust】
It could be live selling, gaming, a dance/music performance, a chat stream, a lecture, an outdoor walk-and-talk, an interview podcast, sports commentary, an unboxing… the highlights sit in completely different places. Judge the type first, then weight accordingly:
- **Content-in-the-words** (selling / lecture / interview / commentary / review): the highlight is what was said — judge from the transcript
- **Reaction-driven** (gaming / chat / outdoor / sports): at a peak moment the text is often just "holy—" with zero information. Lean on vocal-emotion peaks and live-chat spikes; use the transcript only to confirm what happened
- **Visual-driven** (dance / singing / scenery): the transcript is essentially empty — never pick a moment just because a line reads well. Go by visual-energy windows, musical phrasing and chat
If you can't tell, default to content-in-the-words — but don't dress up filler chatter as a quotable.

【Hunt these, in descending order of viral odds】
1. Self-contradiction / getting caught out: the same person saying opposite things — "we'll never discount" followed by a discount, hyping then trashing, promises that don't match what they did, double standards. The strongest hook there is; worth digging out of two far-apart parts of the transcript
2. Conflict and friction: a question they don't want to answer, pushing back on someone live, a fail, an accident, a real argument
3. Counterintuitive one-liners: a single sentence that flips conventional wisdom ("the harder you work, the poorer you get") and travels on its own
4. Emotional peaks: worked up, breaking down, raw sincerity, a sudden drop — tone itself is the content
5. Jokes: only as a complete setup→punchline unit. A clip where the audience laughs but the punchline itself is missing is NEVER acceptable
6. Dense, saveable value: methods, checklists, concrete numbers (platforms now weight saves highest)
7. Live-selling specifics: a product behaving unexpectedly, the moment the price drops, a demo going wrong, being pressed on ingredients or returns

【The first line decides everything】
A clip's opening sentence must carry the hook. Patterns that stop the scroll:
- Counterintuitive / caught-out (strongest): "you think X, actually Y", "stop believing X", "real X isn't Y", "the more X the more Y"
- Result-gap: "I did Y in X months", "from X to Y", "turns out X"
- Suspense: "I found a secret", "never do X", "this is why X"
- Pain point: "are you also X?", "90% of people don't know X"
Greetings, self-introductions, "next up let's look at…", slow build-ups — never open a clip on these.

【Length】
Length 8–40 seconds (roughly 2–8 transcript sentences).

【Two far-apart moments? Then "parts" is REQUIRED】
Almost every clip is one continuous stretch — just use quoteStart/quoteEnd.
But whenever the two moments you want are **separated by a long stretch of unrelated talk** (category 1, getting caught out, almost always is: the promise early on, the contradiction ten minutes later), you MUST emit a "parts" array framing each one.
⚠ This is not optional: if you instead set startSegmentId to the earlier line and endSegmentId to the later one, the system cuts EVERYTHING in between into the clip — it blows past the length limit and the candidate gets dropped, so the hook you found is wasted.
How to write parts:
- List 2–3 parts in source-time order; that order IS the playback order — never reverse it
- Each part must be a complete, un-truncated thought (≥2 seconds); the SUM of the parts must still satisfy the length requirement above (the span between them doesn't count — only what actually gets cut in)
- With "parts", still fill the top-level fields: startSegmentId/quoteStart from the first part, endSegmentId/quoteEnd from the last
- Stitching must never manufacture a meaning that was not there. If the gap contains a "but/however" that reverses it, or the second part is actually about something else, don't stitch — drop the candidate. When in doubt, cut one continuous clip

【Hard rules】
1. Select ONLY from the transcript verbatim: quoteStart/quoteEnd must be copied character-for-character (punctuation included) — never paraphrase, never invent
2. quoteStart = the opening words of the clip's first sentence (≥6 words/characters); quoteEnd = the closing words of its last sentence (≥6 words/characters)
3. startSegmentId/endSegmentId must be the **actual [id] numbers from the transcript** (if the first line is [21], put 21) — never -1, 0 or blank; score must be an integer 0-100, likewise never -1
4. Do not output clock timestamps (hh:mm:ss) — the system reverse-matches the text you quoted; but the two sentence ids and score above ARE required, don't drop them too
5. Clips must not overlap; quality over quantity — do not force weak picks
6. Never quote-mine: the clipped meaning must match what was actually said. A "hook" manufactured by cutting a sentence in half will backfire on the account
7. Write title/hook/reason in the SAME language as the transcript`;

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

/** 三档时长目标:短=快节奏竖屏(抖音/TikTok 完播友好),标准=现默认,长=B站/播客金句段。 */
export const CLIP_LENGTH_RANGES: Record<ClipLength, { minSec: number; maxSec: number }> = {
  short: { minSec: 10, maxSec: 30 },
  standard: { minSec: 8, maxSec: 40 },
  long: { minSec: 40, maxSec: 90 },
};

export function highlightSystemPrompt(
  transcript: Transcript,
  length: ClipLength = "standard",
  products: string[] = [],
  reference?: ReferenceProfile,
  reviewMemory?: ReviewRecord[],
  genre?: { id?: string; custom?: string },
  brief?: { focus?: string; exclude?: string },
  performanceMemory?: PerformanceEntry[]
): string {
  const zh = isChineseTranscript(transcript);
  let base = zh ? HIGHLIGHT_SYSTEM_PROMPT_ZH : HIGHLIGHT_SYSTEM_PROMPT_EN;
  if (length !== "standard") {
    // 时长行按档改写(硬约束进 system prompt,选段时就按目标节奏挑)
    const { minSec, maxSec } = CLIP_LENGTH_RANGES[length];
    base = base
      .replace("时长 8~40 秒", `时长 ${minSec}~${maxSec} 秒(硬要求,宁短勿超)`)
      .replace("Length 8–40 seconds", `Length ${minSec}–${maxSec} seconds (hard requirement)`);
  }
  // 品类判据:不同品类连"该信哪路证据"都不一样,放在通用判据之后覆盖它
  if (genre) base += genreSection(genre.id, zh, genre.custom);
  if (products.length > 0) base += productSection(products, zh);
  // 用户点题:明确的人工意图,优先级压过通用判据(对齐 OpusClip Contextual Prompting)
  base += briefSection(brief, zh);
  // 参考爆款画像:节奏偏好段(用户丢了对标切片时才有)
  if (reference) base += referencePromptSection(reference, zh);
  // 审阅偏好回流:本机历史采用/否决样例(空记忆返回 "")
  if (reviewMemory && reviewMemory.length > 0) base += reviewMemorySection(reviewMemory, zh);
  // 真实发布表现:观众结果信号比模型猜热点更硬,但仍只作趋势证据
  if (performanceMemory && performanceMemory.length > 0) base += performanceMemorySection(performanceMemory, zh);
  return base;
}

/**
 * 商品讲解模式的选段偏好(判据来自带货切片实操调研):转化排序为
 * 演示/实测 > 卖点讲解 > 价格机制 > 催单 > 答疑;憋单/高压催单段有
 * 平台违规风险,明确排除。话术信号词帮 LLM 定位讲解区间的起止。
 */
export function productSection(products: string[], zh: boolean): string {
  const list = products.join(zh ? "、" : ", ");
  if (zh) {
    return (
      `\n\n【商品讲解模式】用户指定了商品词:${list}。本场是带货直播,只选与这些商品直接相关的片段,按转化价值排序:` +
      `①试用/上身/实测演示(眼见为实,最优先) ②核心卖点讲解(材质/成分/对比,"这款是什么面料""上身效果") ` +
      `③价格与机制("原价X今天只要Y""买一送一""叠加优惠券") ④催单只保留紧邻讲解或上链接的部分("三二一,上链接"是天然收尾),不单独成片 ⑤答疑打消顾虑(尺码/成分/售后)。` +
      `讲解区间常以"接下来/下一个/X号链接给大家讲"开始、"我们看下一款"结束,可据此定位。` +
      `一律不选:与商品无关的闲聊寒暄、等人垫场、纯憋单拉互动("点赞到X万才上链接"——平台判违规,切出去会限流)、同一句机制话术机械循环、讲解被打断或商品不完整的碎片。` +
      `每条候选的 keywords 必须包含它命中的商品词。` +
      `\n【带货三段式拼接】2026 年最能出单的带货切片结构是「痛点→演示→价格」三段:开头一句戳中为什么需要它,中间接试用/实测的眼见为实,结尾落在价格/机制给出下单理由。` +
      `同一商品的这三类内容在直播里往往相隔很远——只要能凑齐其中两到三段,就优先用 parts 按「痛点→演示→价格」的顺序拼成一条完整种草片(每段完整不掐断,总时长仍守上限),并在 reason 里写明拼了哪几个要素;` +
      `要素凑不齐就不硬拼,按单段选。拼接仍然不许改变原意——痛点和演示必须真的在说同一个商品。`
    );
  }
  return (
    `\n\n[Product mode] The user specified product keywords: ${list}. This is a live-selling stream — only pick segments directly about these products, ranked by conversion value: ` +
    `(1) try-on/live-demo moments (seeing is believing), (2) key selling-point explanations, (3) price & bundle mechanics, (4) call-to-action lines only when adjacent to a demo/link drop (never standalone), (5) objection-handling Q&A. ` +
    `Skip idle chat, stalling-for-engagement segments (platforms flag these as violations), repeated price-script loops, and fragments where the pitch is cut off. ` +
    `Each candidate's keywords must include the product words it matches.` +
    `\n[Selling three-act stitch] The highest-converting selling clip in 2026 is a "pain point → demo → price" three-act cut: open on why the viewer needs it, show the live demo, land on the price/deal. ` +
    `These three beats for one product usually sit far apart in the stream — whenever you can gather two or three of them, prefer a "parts" stitch in pain→demo→price order (each part complete, total length within the limit) and say in reason which beats you stitched; ` +
    `if the beats aren't all there, don't force it — pick a single continuous segment instead. Stitching must never change meaning: the pain point and the demo must genuinely be about the same product.`
  );
}

/** 点题文本的长度上限(超长注入只会稀释判据)。 */
export const BRIEF_MAX_CHARS = 300;

/**
 * 用户点题段(v0.13):用户用自然语言指定「重点找什么/明确不要什么」。
 * 这是唯一一段真正的人工意图,优先级要压过所有自动判据——但排除不等于
 * 无中生有:重点内容在素材里真不存在时宁可少给,不许硬凑。
 */
export function briefSection(brief: { focus?: string; exclude?: string } | undefined, zh: boolean): string {
  const focus = brief?.focus?.trim().slice(0, BRIEF_MAX_CHARS) ?? "";
  const exclude = brief?.exclude?.trim().slice(0, BRIEF_MAX_CHARS) ?? "";
  if (!focus && !exclude) return "";
  if (zh) {
    const lines = [
      "\n\n【用户点题】用户对本场切片提了明确要求,优先级高于上面的通用判据:",
      ...(focus ? [`- 重点找:${focus}`] : []),
      ...(exclude ? [`- 明确排除:${exclude}(这类内容再精彩也不要选)`] : []),
      "点题只改变「找什么」,不改变质量标准——素材里真没有用户要的内容时,宁可少给或不给,绝不硬凑不相关的片段充数。",
    ];
    return lines.join("\n");
  }
  const lines = [
    "\n\n[User brief] The user gave explicit instructions for this session — they override the general criteria above:",
    ...(focus ? [`- Focus on: ${focus}`] : []),
    ...(exclude ? [`- Explicitly exclude: ${exclude} (skip these even if they are strong)`] : []),
    "The brief changes WHAT to hunt, not the quality bar — if the requested content simply isn't in the footage, return fewer clips rather than padding with unrelated picks.",
  ];
  return lines.join("\n");
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

/**
 * 多片段拼接的可选字段说明。单独列出而不是塞进 OUTPUT_SHAPE:示例里出现
 * parts 会让模型以为每条都该拼,而拼接本来就应该是少数情况。
 */
const PARTS_SHAPE_ZH = `需要多片段拼接时(只有必须前后对照的那一条才用),在那一条 clip 里额外加 parts 字段;不需要拼接就完全不要出现这个字段:
"parts": [
  {"startSegmentId": 12, "endSegmentId": 13, "quoteStart": "...", "quoteEnd": "..."},
  {"startSegmentId": 88, "endSegmentId": 90, "quoteStart": "...", "quoteEnd": "..."}
]`;

const PARTS_SHAPE_EN = `When a clip genuinely needs stitching (only the one that requires the before/after contrast), add a "parts" field to THAT clip; omit the field entirely otherwise:
"parts": [
  {"startSegmentId": 12, "endSegmentId": 13, "quoteStart": "...", "quoteEnd": "..."},
  {"startSegmentId": 88, "endSegmentId": 90, "quoteStart": "...", "quoteEnd": "..."}
]`;

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
  if (signals.motionPeaks && signals.motionPeaks.length > 0) {
    lines.push(zh ? `- 画面运动活跃段(低分辨率帧差,动作/移动线索): ${fmt(signals.motionPeaks)}` : `- Motion-active windows (low-resolution frame differences; action/movement cue): ${fmt(signals.motionPeaks)}`);
  }
  if (signals.visualPeaks && signals.visualPeaks.length > 0) {
    lines.push(zh ? `- 视觉模型判定的画面爆点时刻(夸张表情/激烈动作/场面炸裂): ${fmt(signals.visualPeaks)}` : `- Vision-model visual peaks (expressions/action/spectacle): ${fmt(signals.visualPeaks)}`);
  }
  if (signals.emotionPeaks && signals.emotionPeaks.length > 0) {
    lines.push(zh ? `- 人脸表情峰值时段(大笑/惊讶/激动): ${fmt(signals.emotionPeaks)}` : `- Facial-emotion peaks (laughter/surprise/excitement): ${fmt(signals.emotionPeaks)}`);
  }
  if (signals.voiceEmotionPeaks && signals.voiceEmotionPeaks.length > 0) {
    lines.push(zh ? `- 说话人语气激动时段(笑着说/吼出来/惊到了——同一句话文字看不出的情绪): ${fmt(signals.voiceEmotionPeaks)}` : `- Vocal-emotion peaks (said while laughing / shouted / startled — tone the text cannot show): ${fmt(signals.voiceEmotionPeaks)}`);
  }
  if (signals.audioEventPeaks && signals.audioEventPeaks.length > 0) {
    // 笑声是滞后结果:包袱在它之前。这里必须写清用法,否则 LLM 会直接切哄笑段(那里没人说话)
    lines.push(
      zh
        ? `- 观众笑声/掌声时段: ${fmt(signals.audioEventPeaks)}\n  ⚠ 笑声是「结果」不是爆点本身——引爆它的那句包袱落在笑声开始之前。要往前找到那句话、连同它的铺垫一起选,笑声只留一点点做收尾;绝不要只切观众在笑的那几秒(那里根本没人说话)`
        : `- Audience laughter / applause: ${fmt(signals.audioEventPeaks)}\n  ⚠ Laughter is the RESULT, not the highlight — the punchline that triggered it lands BEFORE the laughter starts. Walk back to that line, include its setup, and keep only a beat of laughter as the tail; never clip just the laughing seconds (nobody is speaking there)`
    );
  }
  if (signals.danmakuPeaks && signals.danmakuPeaks.length > 0) {
    lines.push(zh ? `- 弹幕热度峰值时段(观众实时高能反应,证据力最强): ${fmt(signals.danmakuPeaks)}` : `- Live-chat density peaks (real-time audience hype, strongest evidence): ${fmt(signals.danmakuPeaks)}`);
  }
  if (signals.clipCommandMarks && signals.clipCommandMarks.length > 0) {
    const marks = signals.clipCommandMarks.map(fmtClock).join(", ");
    // 口令与笑声同理是滞后标记:被认证的内容在口令之前——用法必须写死在提示词里
    lines.push(
      zh
        ? `- 主播剪辑口令时刻(主播亲口说「这段剪下来/切片」——他本人实时认证的爆点,证据力最高): ${marks}\n  ⚠ 口令指的是它**之前**刚发生的内容:从口令时刻往前找到被指的那段完整内容来选,不要把口令本身当片段(必要时可把口令那句留作收尾)`
        : `- Streamer clip commands (the host literally said "clip that" — self-certified highlights, highest-value evidence): ${marks}\n  ⚠ The command points at what JUST happened **before** it: walk back from the mark to the complete moment being referenced; never clip the command line itself (at most keep it as the tail)`
    );
  }
  if (signals.visualNotes && signals.visualNotes.length > 0) {
    const notes = signals.visualNotes
      .map((n) => `${fmtClock(n.t)} ${n.note || (zh ? "画面高能" : "visual peak")}(${n.energy}/10)`)
      .join(zh ? ";" : "; ");
    lines.push(
      zh
        ? `- 全场画面时刻线(视觉模型逐段扫过整场后的画面描述——文字稿看不见的画面事件都在这里): ${notes}\n  与其中高分时刻重合的内容,画面上真的有东西;文字平平但画面描述炸裂的时刻值得选`
        : `- Full-stream visual timeline (a vision model swept the whole stream — on-screen events the transcript cannot show): ${notes}\n  Moments overlapping high-energy notes really have something on screen; flat text + explosive visuals is still a pick`
    );
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

${PARTS_SHAPE_ZH}

字段说明:title=适合发布的短标题(≤20字);hook=开头钩子句原文;score=0-100 相对排序分;reason=一句话为什么能爆;quoteStart/quoteEnd=片段首句开头/末句结尾的逐字原文;keywords=该片段里 3-5 个最有冲击力的词,必须逐字取自片段原文(用于字幕划重点)。
要求:按 score 从高到低排;片段互不重叠。`;
  }
  return `Pick at most ${maxClips} clip candidates with the highest viral potential from the transcript below.

【Transcript】(format: [sentenceId] startTime text)
${renderTranscriptLines(transcript)}
${speakerNote(transcript, false)}${renderSignals(signals, false)}
【Output format】Respond with STRICT JSON only, no extra text:
${OUTPUT_SHAPE}

${PARTS_SHAPE_EN}

Fields: title = a post-ready short title (≤ 12 words); hook = the verbatim opening hook line; score = 0-100 relative ranking; reason = one line on why it can go viral; quoteStart/quoteEnd = verbatim opening/closing words of the clip; keywords = the 3-5 punchiest words/phrases inside the clip, copied verbatim (used to emphasize caption keywords).
Sort by score descending; clips must not overlap.`;
}

// ---------- 信号驱动通道:文字稿没内容时按「时刻」挑 ----------

export const MOMENT_SYSTEM_PROMPT_ZH = `你是一位顶级短视频切片操盘手,现在处理的是一场**文字稿基本没有信息量**的直播——跳舞、才艺、唱歌、户外、游戏这类,观众看的是画面和反应,不是台词。

所以这次不要求你引用原话。系统已经用画面和声音信号圈出了若干「高能时刻」并编好号,你的工作是:从中挑出真正值得剪成短视频的几个,给它们起标题、写钩子。

【怎么判断一个时刻值不值得剪】
- 证据里出现「画面高能/镜头切换密集」→ 大概率是动作、场面或表演的高潮
- 出现「弹幕峰值」→ 观众在这一刻真的有反应,这是最硬的证据(观众用实时投票告诉你哪里好看)
- 出现「语气激动/笑声掌声」→ 主播或现场在这一刻情绪爆发
- 只有「响度峰值」一路孤证 → 很可能只是背景音乐变大或环境噪声,要谨慎
- 证据种类越多、越互相印证的时刻越可信;只有一路信号的要敢于放弃

【铁律】
1. 只能从给定的时刻里挑,momentId 必须是真实存在的编号,绝不能自己编时间
2. 宁缺毋滥:一场直播真正值得剪的通常只有两三个时刻,不要为凑数把普通片段说成高能
3. 附带的原话只是参考,可能是空的、可能是错字连篇(户外收音差)——**绝不要因为"某句话读起来还行"就选它**,也不要把明显读不通的转写当内容
4. title 要写观众刷到时会点开的那种,而不是"精彩片段1";没有台词可用时,就描述画面上会发生什么
5. hook 写这条片子开头会呈现的画面或那一下动作(一句话),不要编造台词
6. score 是 0-100 的整数,必填,不能填 -1
7. title/hook/reason 用与附带原话相同的语言写(原话为空时用中文)`;

export const MOMENT_SYSTEM_PROMPT_EN = `You are a top short-form clipping strategist. This stream's transcript carries almost no information — dance, performance, singing, outdoor or gaming content, where viewers come for the picture and the reactions, not the words.

So you are NOT asked to quote anything. The system has already used audio and visual signals to mark numbered "high-energy moments". Your job: pick the ones genuinely worth cutting, and title them.

【How to judge a moment】
- Visual-energy / dense scene cuts → likely the peak of an action, a spectacle or a performance
- Live-chat spike → the audience actually reacted here; this is the hardest evidence there is
- Vocal-emotion peak / laughter / applause → the host or the room broke out at this instant
- Loudness alone, with nothing else → often just louder music or ambient noise. Be skeptical
- The more signal types corroborate each other, the more trustworthy. Drop single-signal moments freely

【Hard rules】
1. Pick ONLY from the given moments; momentId must be a real number from the list — never invent times
2. Quality over quantity: a stream usually has two or three moments truly worth clipping
3. The attached transcript is reference only — it may be empty or full of garbled ASR (outdoor audio is poor). NEVER pick a moment just because a line reads well, and don't treat unreadable transcription as content
4. Write a title someone would actually tap, not "Highlight 1". With no usable dialogue, describe what happens on screen
5. hook = the image or the beat this clip opens on, in one line. Do not invent dialogue
6. score is an integer 0-100, required, never -1
7. Write title/hook/reason in the same language as the attached transcript (Chinese when it is empty)`;

const MOMENT_SHAPE = `{
  "clips": [
    { "momentId": 3, "title": "...", "hook": "...", "score": 88, "reason": "...", "keywords": ["...", "..."] }
  ]
}`;

/** 信号种类 → 人话标签(证据链既给 LLM 看,也给用户看)。 */
export const EVIDENCE_LABELS: Record<string, { zh: string; en: string }> = {
  loud: { zh: "响度峰值", en: "loudness peak" },
  cut: { zh: "镜头切换密集", en: "dense scene cuts" },
  motion: { zh: "画面运动", en: "motion activity" },
  visual: { zh: "画面高能(视觉模型)", en: "visual energy (vision model)" },
  emotion: { zh: "人脸表情峰值", en: "facial-emotion peak" },
  voice: { zh: "语气激动", en: "vocal-emotion peak" },
  audioEvent: { zh: "笑声/掌声", en: "laughter/applause" },
  danmaku: { zh: "弹幕峰值", en: "live-chat spike" },
};

/**
 * 每个时刻附带的参考原话截断长度。这段文字提示词里已明说「只是参考」,
 * 而这类素材的转写往往是噪声(户外收音差/唱跳只有零散词),整段贴进去
 * 只会淹没证据行——实测会把模型逼回模板输出。
 */
export const MOMENT_TEXT_MAX_CHARS = 120;

export interface PromptMoment {
  id: number;
  startSec: number;
  endSec: number;
  evidence: string[];
  /** 该时段的原话(可能为空/无信息量——提示词里已明确不要以它为准)。 */
  text: string;
}

export function buildMomentPrompt(moments: PromptMoment[], maxClips: number, zh: boolean): string {
  const lines = moments
    .map((m) => {
      const ev = m.evidence.map((e) => EVIDENCE_LABELS[e]?.[zh ? "zh" : "en"] ?? e).join(zh ? "、" : ", ");
      const dur = Math.round(m.endSec - m.startSec);
      const raw = m.text.trim().replace(/\s+/g, " ");
      const text = raw.length > MOMENT_TEXT_MAX_CHARS ? `${raw.slice(0, MOMENT_TEXT_MAX_CHARS)}…` : raw;
      return zh
        ? `[${m.id}] ${fmtClock(m.startSec)}-${fmtClock(m.endSec)}(${dur}秒)\n  证据:${ev || "(无)"}\n  该时段原话:${text || "(没有台词)"}`
        : `[${m.id}] ${fmtClock(m.startSec)}-${fmtClock(m.endSec)} (${dur}s)\n  Evidence: ${ev || "(none)"}\n  Transcript here: ${text || "(no dialogue)"}`;
    })
    .join("\n");
  return zh
    ? `下面是系统按画面与声音信号圈出的高能时刻,请从中挑出最多 ${maxClips} 个值得剪成短视频的。

【高能时刻清单】
${lines}

【输出格式】严格输出 JSON,不要任何多余文字:
${MOMENT_SHAPE}

字段说明:momentId=上面清单里的编号(必须真实存在);title=适合发布的短标题(≤20字);hook=开头呈现的画面/动作(一句话);score=0-100 相对排序分;reason=一句话为什么值得剪(要说清你信的是哪路证据);keywords=2-5 个描述这条内容的词(用于发布文案话题)。
按 score 从高到低排;宁可少给几条,也不要把平淡时刻硬说成高能。`
    : `Below are high-energy moments marked by audio and visual signals. Pick at most ${maxClips} worth cutting.

【Moments】
${lines}

【Output format】STRICT JSON only, no extra text:
${MOMENT_SHAPE}

Fields: momentId = a real number from the list; title = post-ready short title (≤12 words); hook = the opening image or beat, one line; score = 0-100 relative ranking; reason = one line on why it's worth cutting (say which evidence you trusted); keywords = 2-5 descriptive words for post hashtags.
Sort by score descending; returning fewer, stronger picks beats padding the list.`;
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
- flow 结构:是不是断章取义?开头是否像半截话、结尾有没有收住?逻辑顺不顺?片段文本里出现「……」表示这条是把相隔很远的两段拼起来的,要按更严的标准查:拼起来之后的意思是不是原话本来的意思?有没有靠跳过中间内容制造出一个原本不存在的矛盾?只要拼得牵强就 keep=false
- value 价值:不看原视频,这条有没有信息量或情绪价值?值不值得看完?
- trend 热点:话题/情绪贴不贴近当下平台上正在火的内容?
另外给每条写一个 teaser:≤15 个字的悬念句,能印在视频开头当文字钩子,要勾人但不剧透。
每条还要做「零上下文可懂性」终判——假装你完全没看过这场直播,只看这条片段:能不能懂?结尾像不像一个结尾?据此给出 verdict 三档:
- "publish":直接发没问题——单独看得懂、开头能停手指、结尾收得住
- "review":有硬伤但救得回来,需要人工确认(开头像半截话/结尾没收住/需要一点上下文/拼接略牵强)——在 note 里写清具体是哪个硬伤
- "drop":不值得发布——不完整的思想、凑数的平庸内容、断章取义、单独看根本看不懂
你要敢于判 drop:AI 选段有三四成是废片是行业现实,发废片的代价是整个账号被限流。这是发布前的最后一道质量门。keep 字段继续填(publish 填 true,其余填 false)。`;

export const REVIEW_SYSTEM_PROMPT_EN = `You are a ruthless short-form content reviewer. You receive pre-cut clip candidates and judge each one blind, as a stranger scrolling past, scoring FOUR dimensions (0-100 each) with a one-line reason per dimension:
- hook: does the FIRST line stop the scroll within 3 seconds? Flat openings fail.
- flow: is it quote-mined? Does it start mid-thought or end without landing? Does it flow? A "……" inside the clip text means it was stitched from two far-apart moments — hold those to a stricter bar: does the stitched meaning match what was actually said, or was a contradiction manufactured by skipping what sat in between? Any strained stitch gets keep=false
- value: without the source video, is it informative or emotionally worth watching to the end?
- trend: does the topic/emotion ride what is currently hot on the platforms?
Also write a teaser per clip: a suspense line of ≤8 words that could be printed at the top of the video as a text hook — intriguing, no spoilers.
Finish each clip with a ZERO-CONTEXT verdict — pretend you never saw the stream and only watch this clip: can you follow it, and does the ending land? Emit one of three tiers:
- "publish": safe to post as-is — stands alone, the opening stops the scroll, the ending lands
- "review": has a fixable flaw and needs a human look (opens mid-thought / ending doesn't land / needs a little context / stitch is slightly strained) — name the flaw in note
- "drop": not worth publishing — incomplete thought, filler, quote-mined, or incomprehensible on its own
Judge "drop" without mercy: 30-45% of AI picks being duds is the industry reality, and posting duds throttles the whole account. You are the final quality gate. Keep filling keep (true for publish, false otherwise).`;

export function reviewSystemPrompt(transcript: Transcript): string {
  return isChineseTranscript(transcript) ? REVIEW_SYSTEM_PROMPT_ZH : REVIEW_SYSTEM_PROMPT_EN;
}

const REVIEW_SHAPE = `{
  "reviews": [
    {
      "id": 1, "keep": true, "verdict": "publish",
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
  /** 多片段拼接的段清单;有它时时长要按各段之和报,不是跨度。 */
  pieces?: ClipPiece[];
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
      const dur = Math.round(clipDurationSec(c));
      const stitched = isStitched(c.pieces)
        ? zh
          ? `(${c.pieces!.length} 段拼接)`
          : ` (${c.pieces!.length}-part stitch)`
        : "";
      return zh
        ? `【候选 ${c.id}】《${c.title}》 时长${dur}秒${stitched}\n前文:${ctx.before || "(无)"}\n片段:${c.text}\n后文:${ctx.after || "(无)"}`
        : `【Candidate ${c.id}】"${c.title}" ${dur}s${stitched}\nBefore: ${ctx.before || "(none)"}\nClip: ${c.text}\nAfter: ${ctx.after || "(none)"}`;
    })
    .join("\n\n");
  return zh
    ? `逐条盲评下面的候选片段。hook/flow/value/trend 四维各 0-100 打分(横向比较)+ 各一句话理由;teaser=≤15字悬念句(勾人不剧透,逐句稿同款语言);verdict=质量门三档(publish/review/drop,判法见系统要求);keep 与 verdict 对应(publish=true,其余 false);note=一句话总评(review/drop 必须说清具体硬伤)。\n\n${blocks}\n\n【输出格式】严格输出 JSON,不要任何多余文字:\n${REVIEW_SHAPE}`
    : `Blind-review each candidate below. Score hook/flow/value/trend 0-100 each (relative) with a one-line reason per dimension; teaser = a ≤8-word suspense line (intriguing, no spoilers, transcript language); verdict = the three-tier gate (publish/review/drop, per the system rules); keep mirrors verdict (true only for publish); note = one-line overall verdict (must name the flaw for review/drop).\n\n${blocks}\n\n【Output format】STRICT JSON only:\n${REVIEW_SHAPE}`;
}
