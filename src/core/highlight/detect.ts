/**
 * Highlight detection orchestrator: transcript → LLM selections → reverse
 * matching → validated HighlightCandidate list.
 */
import type { Transcript } from "../transcribe/types";
import type { MediaSignals } from "../signals";
import type { ReferenceProfile } from "../reference";
import type { ReviewRecord } from "../review-memory";
import type { HighlightCandidate, LlmConfig, PrefilterConfig, FunnelStats, ClipLength } from "../../shared/api-types";
import {
  highlightSystemPrompt,
  buildHighlightPrompt,
  reviewSystemPrompt,
  buildReviewPrompt,
  extractJson,
  CLIP_LENGTH_RANGES,
  isChineseTranscript,
  MOMENT_SYSTEM_PROMPT_ZH,
  MOMENT_SYSTEM_PROMPT_EN,
  buildMomentPrompt,
} from "./prompt";
import { resolveSelection, type RawSelection, type RawPart } from "./match";
import { prefilterTranscript } from "./prefilter";
import { clipDurationSec, MAX_PIECES, type ClipPiece } from "../../shared/pieces";
import { genrePreset, normalizeGenreId, type EvidenceClass } from "../genre";
import {
  fuseMoments,
  shouldRunMoments,
  speechRatio,
  MOMENT_WEIGHTS,
  type SignalMoment,
} from "./moments";

/**
 * 时长档过滤界:目标范围外放容差(下 0.5×/上 1.5×)——LLM 轻微超标的候选
 * 留给用户决定,离谱的直接丢;绝对下限 4 秒防碎片。
 */
export function clipLengthBounds(length: ClipLength = "standard"): { lo: number; hi: number } {
  const r = CLIP_LENGTH_RANGES[length];
  return { lo: Math.max(4, Math.round(r.minSec * 0.5)), hi: Math.round(r.maxSec * 1.5) };
}

/**
 * Pollinations' keyless tier serves a reasoning model with a small output
 * budget — without reasoning_effort:"low" it spends every token thinking and
 * returns empty content. Scoped to that host; real OpenAI rejects the param.
 */
export function extraParams(baseUrl: string): Record<string, unknown> {
  return /pollinations\.ai/i.test(baseUrl) ? { reasoning_effort: "low" } : {};
}

/** Call an OpenAI-compatible chat endpoint. Throws with an actionable message. */
export async function chatComplete(llm: LlmConfig, system: string, user: string, signal?: AbortSignal): Promise<string> {
  const url = `${llm.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${llm.apiKey}`,
      },
      body: JSON.stringify({
        model: llm.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.6,
        max_tokens: 4000,
        ...extraParams(llm.baseUrl),
      }),
      signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`无法连接 LLM 服务 / cannot reach LLM endpoint (${llm.baseUrl}): ${msg}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`LLM 请求失败 / LLM request failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  let data: { choices?: Array<{ message?: { content?: string } }> };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`LLM 返回非 JSON 响应 / non-JSON response: ${text.slice(0, 200)}`);
  }
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM 未返回内容 / empty LLM response");
  return content;
}

/**
 * 解析多片段拼接的 parts 数组(缺省/畸形一律当作没写,退回单段)。
 * 每段至少要有引文或有效句 id 才收;超过 MAX_PIECES 的多余段在 normalizePieces
 * 里按时长取舍,这里只做防爆量截断。
 */
export function parseParts(raw: unknown): RawPart[] | undefined {
  if (!Array.isArray(raw) || raw.length < 2) return undefined;
  const out: RawPart[] = [];
  for (const p of raw.slice(0, MAX_PIECES * 2)) {
    if (typeof p !== "object" || p === null) continue;
    const o = p as Record<string, unknown>;
    const quoteStart = String(o.quoteStart ?? "").trim();
    const startSegmentId = Number(o.startSegmentId);
    const endSegmentId = Number(o.endSegmentId);
    if (!quoteStart && !Number.isFinite(startSegmentId)) continue;
    out.push({
      startSegmentId: Number.isFinite(startSegmentId) ? startSegmentId : -1,
      endSegmentId: Number.isFinite(endSegmentId) ? endSegmentId : -1,
      quoteStart,
      quoteEnd: String(o.quoteEnd ?? "").trim(),
    });
  }
  return out.length >= 2 ? out : undefined;
}

/** Parse + validate the LLM's clips JSON into RawSelections (drops malformed rows). */
export function parseSelections(content: string): RawSelection[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(content));
  } catch {
    throw new Error(`LLM 返回的内容不是合法 JSON / invalid JSON: ${content.slice(0, 200)}`);
  }
  const clips = (parsed as { clips?: unknown[] })?.clips;
  if (!Array.isArray(clips)) throw new Error("LLM 输出缺少 clips 数组 / missing clips array");
  const out: RawSelection[] = [];
  for (const c of clips) {
    if (typeof c !== "object" || c === null) continue;
    const r = c as Record<string, unknown>;
    const quoteStart = String(r.quoteStart ?? "").trim();
    const quoteEnd = String(r.quoteEnd ?? "").trim();
    const startSegmentId = Number(r.startSegmentId);
    const endSegmentId = Number(r.endSegmentId);
    if (!quoteStart && !Number.isFinite(startSegmentId)) continue;
    out.push({
      parts: parseParts(r.parts),
      title: String(r.title ?? "").trim() || "未命名片段",
      hook: String(r.hook ?? "").trim(),
      score: Math.max(0, Math.min(100, Number(r.score) || 0)),
      reason: String(r.reason ?? "").trim(),
      startSegmentId: Number.isFinite(startSegmentId) ? startSegmentId : -1,
      endSegmentId: Number.isFinite(endSegmentId) ? endSegmentId : -1,
      quoteStart,
      quoteEnd,
      keywords: Array.isArray(r.keywords)
        ? r.keywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 8)
        : [],
    });
  }
  return out;
}

/** 信号通道的一条选择:LLM 只报时刻编号,不引用原话。 */
export interface RawMomentPick {
  momentId: number;
  title: string;
  hook: string;
  score: number;
  reason: string;
  keywords: string[];
}

/** 解析信号通道的输出(畸形行丢弃)。 */
export function parseMomentPicks(content: string): RawMomentPick[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(content));
  } catch {
    throw new Error(`LLM 返回的内容不是合法 JSON / invalid JSON: ${content.slice(0, 200)}`);
  }
  const clips = (parsed as { clips?: unknown[] })?.clips;
  if (!Array.isArray(clips)) throw new Error("LLM 输出缺少 clips 数组 / missing clips array");
  const out: RawMomentPick[] = [];
  for (const c of clips) {
    if (typeof c !== "object" || c === null) continue;
    const r = c as Record<string, unknown>;
    const momentId = Number(r.momentId);
    if (!Number.isFinite(momentId)) continue;
    out.push({
      momentId,
      title: String(r.title ?? "").trim() || "未命名片段",
      hook: String(r.hook ?? "").trim(),
      score: Math.max(0, Math.min(100, Number(r.score) || 0)),
      reason: String(r.reason ?? "").trim(),
      keywords: Array.isArray(r.keywords)
        ? r.keywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 8)
        : [],
    });
  }
  return out;
}

/** 落在 [startSec, endSec] 内的整句文本(信号候选的展示文本)。 */
export function textInRange(transcript: Transcript, startSec: number, endSec: number): string {
  return transcript.segments
    .filter((s) => s.endSec > startSec && s.startSec < endSec)
    .map((s) => s.text)
    .join(" ");
}

/**
 * 把 LLM 的时刻选择落成候选。时间完全由信号给定(不做任何反查),
 * boundary 标 "signal" —— UI 和回执要能看出这条不是按原话切的。
 */
export function momentsToCandidates(
  transcript: Transcript,
  moments: SignalMoment[],
  picks: RawMomentPick[]
): HighlightCandidate[] {
  const byId = new Map(moments.map((m) => [m.id, m]));
  const out: HighlightCandidate[] = [];
  for (const p of picks) {
    const m = byId.get(p.momentId);
    if (!m) continue; // 编号是编的,丢弃——绝不猜时间
    const text = textInRange(transcript, m.startSec, m.endSec);
    out.push({
      id: out.length + 1,
      startSec: m.startSec,
      endSec: m.endSec,
      text,
      title: p.title,
      hook: p.hook,
      score: p.score,
      reason: p.reason,
      boundary: "signal",
      // 关键词可能来自画面描述而非原话,所以这里不做"必须在片内出现"的过滤
      keywords: p.keywords,
      recommended: true,
      reviewNote: "",
      signalEvidence: m.evidence,
    });
  }
  return out;
}

export interface ScoreDims {
  hook: number;
  flow: number;
  value: number;
  trend: number;
}

export interface ReviewVerdict {
  id: number;
  keep: boolean;
  score: number;
  note: string;
  dims?: ScoreDims;
  dimNotes?: { hook: string; flow: string; value: string; trend: string };
  teaser?: string;
}

/** Hook rules the scroll; trend is the softest signal. */
const DIM_WEIGHTS: ScoreDims = { hook: 0.35, flow: 0.25, value: 0.25, trend: 0.15 };

/** Weighted composite of the four dimensions, 0-100. */
export function compositeScore(dims: ScoreDims): number {
  return Math.round(
    dims.hook * DIM_WEIGHTS.hook + dims.flow * DIM_WEIGHTS.flow + dims.value * DIM_WEIGHTS.value + dims.trend * DIM_WEIGHTS.trend
  );
}

/** Parse the stage-2 reviewer output (drops malformed rows). */
export function parseReviews(content: string): ReviewVerdict[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(content));
  } catch {
    throw new Error(`reviewer returned invalid JSON: ${content.slice(0, 200)}`);
  }
  const reviews = (parsed as { reviews?: unknown[] })?.reviews;
  if (!Array.isArray(reviews)) throw new Error("reviewer output missing reviews array");
  const out: ReviewVerdict[] = [];
  for (const r of reviews) {
    if (typeof r !== "object" || r === null) continue;
    const v = r as Record<string, unknown>;
    const id = Number(v.id);
    if (!Number.isFinite(id)) continue;
    const clamp = (x: unknown): number => Math.max(0, Math.min(100, Number(x) || 0));
    // four-dimension shape, with legacy single-score fallback
    const hasDims = ["hook", "flow", "value", "trend"].some((k) => Number.isFinite(Number(v[k])));
    const dims = hasDims
      ? { hook: clamp(v.hook), flow: clamp(v.flow), value: clamp(v.value), trend: clamp(v.trend) }
      : undefined;
    out.push({
      id,
      keep: v.keep !== false,
      score: dims ? compositeScore(dims) : clamp(v.score),
      note: String(v.note ?? "").trim(),
      dims,
      dimNotes: dims
        ? {
            hook: String(v.hookNote ?? "").trim(),
            flow: String(v.flowNote ?? "").trim(),
            value: String(v.valueNote ?? "").trim(),
            trend: String(v.trendNote ?? "").trim(),
          }
        : undefined,
      teaser: String(v.teaser ?? "").trim().slice(0, 30) || undefined,
    });
  }
  return out;
}

/** Merge verdicts onto candidates. Unreviewed ids stay recommended (fail-open). */
export function applyReviews(candidates: HighlightCandidate[], reviews: ReviewVerdict[]): HighlightCandidate[] {
  const byId = new Map(reviews.map((r) => [r.id, r]));
  return candidates.map((c) => {
    const r = byId.get(c.id);
    if (!r) return c;
    return {
      ...c,
      score: r.score || c.score,
      recommended: r.keep,
      reviewNote: r.note,
      scoreDims: r.dims,
      dimNotes: r.dimNotes,
      teaser: r.teaser || undefined,
    };
  });
}

/**
 * Rank-normalise scores the way commercial tools do: the displayed number is
 * a RANK dressed as a score, which sidesteps LLM score drift between runs.
 * Recommended clips land in 76-99 (single clip → 97); rejected ones in 50-70
 * so they always sort below every recommended clip. Order is preserved.
 */
export function normalizeScores(candidates: HighlightCandidate[]): HighlightCandidate[] {
  const assign = (group: HighlightCandidate[], top: number, bottom: number, single: number): Map<number, number> => {
    const ranked = [...group].sort((a, b) => b.score - a.score);
    const m = new Map<number, number>();
    ranked.forEach((c, i) => {
      m.set(c.id, ranked.length === 1 ? single : Math.round(top - ((top - bottom) * i) / (ranked.length - 1)));
    });
    return m;
  };
  const rec = assign(candidates.filter((c) => c.recommended), 99, 76, 97);
  const rej = assign(candidates.filter((c) => !c.recommended), 70, 50, 62);
  return candidates.map((c) => ({ ...c, score: (c.recommended ? rec : rej).get(c.id) ?? c.score }));
}

/** 实际占用的源片区间:多段拼接按段比,否则按整段跨度。 */
function occupiedRanges(c: HighlightCandidate): ClipPiece[] {
  return c.pieces && c.pieces.length > 1 ? c.pieces : [{ startSec: c.startSec, endSec: c.endSec }];
}

/**
 * Drop overlapping candidates, keeping higher scores (they arrive score-sorted).
 * 多段拼接按「段与段」比重叠——否则一条横跨十几分钟的拼接片会把中间所有
 * 候选全吃掉,而它其实只占用了两小段。
 */
export function dropOverlaps(candidates: HighlightCandidate[]): HighlightCandidate[] {
  const kept: HighlightCandidate[] = [];
  for (const c of [...candidates].sort((a, b) => b.score - a.score)) {
    const mine = occupiedRanges(c);
    const overlaps = kept.some((k) =>
      occupiedRanges(k).some((b) => mine.some((a) => a.startSec < b.endSec && a.endSec > b.startSec))
    );
    if (!overlaps) kept.push(c);
  }
  return kept.sort((a, b) => a.startSec - b.startSec).map((c, i) => ({ ...c, id: i + 1 }));
}

export interface DetectOutcome {
  candidates: HighlightCandidate[];
  /** 本地初筛生效时的漏斗统计;未启用或回退全文时缺省。 */
  funnel?: FunnelStats;
}

/** Full detection pass. */
/**
 * 商品词确定性并入候选 keywords:片文本真实包含才算命中(拉丁忽略大小写),
 * 去重保序——关键词字幕的商品强调、发布文案的话题都从这里受益。纯函数。
 */
export function mergeProductKeywords(keywords: string[], clipText: string, products: string[]): string[] {
  if (products.length === 0) return keywords;
  const lower = clipText.toLowerCase();
  const hits = products.map((p) => p.trim()).filter((p) => p && lower.includes(p.toLowerCase()));
  const seen = new Set(keywords.map((k) => k.toLowerCase()));
  return [...keywords, ...hits.filter((h) => !seen.has(h.toLowerCase()))];
}

export async function detectHighlights(
  transcript: Transcript,
  llm: LlmConfig,
  signal?: AbortSignal,
  signals?: MediaSignals,
  prefilter?: PrefilterConfig | null,
  length?: ClipLength,
  products?: string[],
  reference?: ReferenceProfile,
  reviewMemory?: ReviewRecord[],
  /** 直播品类判据(内置预设 id + 用户自定义文本,见 core/genre.ts)。 */
  genre?: { id?: string; custom?: string }
): Promise<DetectOutcome> {
  if (transcript.segments.length === 0) return { candidates: [] };

  // 两级漏斗第一级:本地小模型圈入围区间,云端只精读入围部分。
  // 任何失败静默回退全文(反查仍然用全量转写,所以下游完全无感)。
  let promptTranscript = transcript;
  let funnel: FunnelStats | undefined;
  if (prefilter?.baseUrl && prefilter.model) {
    const local: LlmConfig = { baseUrl: prefilter.baseUrl, apiKey: "ollama", model: prefilter.model };
    const outcome = await prefilterTranscript(transcript, local, chatComplete, signal).catch((e) => {
      // 上游主动取消要中断整个检测;其余错误回退全文
      if (signal?.aborted) throw e;
      return null;
    });
    if (outcome) {
      promptTranscript = outcome.transcript;
      funnel = outcome.funnel;
    }
  }

  const content = await chatComplete(
    llm,
    highlightSystemPrompt(promptTranscript, length, products ?? [], reference, reviewMemory, genre),
    buildHighlightPrompt(promptTranscript, 6, signals),
    signal
  );
  const selections = parseSelections(content);

  const { lo, hi } = clipLengthBounds(length);
  const candidates: HighlightCandidate[] = [];
  for (const sel of selections) {
    const resolved = resolveSelection(transcript, sel);
    if (!resolved) continue;
    // 时长按「成片时长」算:多段拼接是各段之和,不是跨度(跨度可能有十几分钟)
    const dur = clipDurationSec(resolved);
    if (dur < lo || dur > hi) continue;
    candidates.push({
      id: candidates.length + 1,
      startSec: resolved.startSec,
      endSec: resolved.endSec,
      pieces: resolved.pieces,
      text: resolved.text,
      title: sel.title,
      hook: sel.hook,
      score: sel.score,
      reason: sel.reason,
      boundary: resolved.boundary,
      // keep only keywords the clip actually contains — hallucinated ones
      // would silently no-op in caption highlighting anyway;商品词命中的
      // 确定性补齐(不依赖 LLM 记得写),关键词字幕/发布文案都能吃到
      keywords: mergeProductKeywords(
        sel.keywords.filter((k) => resolved.text.toLowerCase().includes(k.toLowerCase())),
        resolved.text,
        products ?? []
      ),
      recommended: true,
      reviewNote: "",
    });
  }
  const textKept = dropOverlaps(candidates);

  // 信号驱动通道:文字稿没内容的品类(舞见/萌宠/美食/户外/游戏/电台…)靠
  // 引用原话根本挑不出东西,改从视听信号融合出的「高能时刻」里挑。
  // fail-open:这一路任何失败都只是没有额外候选,绝不拖垮文本通道的结果。
  const evidence: EvidenceClass = genrePreset(normalizeGenreId(genre?.id)).evidence;
  const ratio = speechRatio(transcript);
  let momentKept: HighlightCandidate[] = [];
  if (signals && shouldRunMoments(evidence, ratio, textKept.length)) {
    momentKept = await detectMoments(transcript, llm, signals, evidence, length, signal).catch((e) => {
      if (signal?.aborted) throw e;
      return [];
    });
  }

  const kept = dropOverlaps([...textKept, ...momentKept]);
  if (kept.length === 0) return { candidates: kept, funnel };

  // Stage 2: adversarial review — a stricter pass judges each clip's hook,
  // completeness and standalone value; weak clips get flagged (not silently
  // dropped) so the UI can default-deselect them and hands-off mode skips
  // them. Fail-open: a broken review call must never take down detection.
  // 复评的上下文用全量转写(不是漏斗后的)——评审要看片段前后文防断章取义。
  //
  // 信号候选**不送复评**:复评的四个维度(钩子/结构/价值/热点)全部按"读文本"
  // 打分,拿它去评一段跳舞或萌宠,必然全判死刑——那正是这条通道要救的品类。
  // applyReviews 对没评到的 id 本来就保持原样(fail-open),所以直接跳过即可。
  const reviewable = kept.filter((c) => c.boundary !== "signal");
  if (reviewable.length === 0) return { candidates: normalizeScores(kept), funnel };
  try {
    const reviewContent = await chatComplete(
      llm,
      reviewSystemPrompt(transcript),
      buildReviewPrompt(transcript, reviewable),
      signal
    );
    return { candidates: normalizeScores(applyReviews(kept, parseReviews(reviewContent))), funnel };
  } catch {
    return { candidates: kept, funnel };
  }
}

/**
 * 信号通道的一趟检测:融合信号取时刻 → LLM 按编号挑 → 落成候选。
 * 时间全程由信号给定,LLM 不需要(也不允许)引用原话。
 */
export async function detectMoments(
  transcript: Transcript,
  llm: LlmConfig,
  signals: MediaSignals,
  evidence: EvidenceClass,
  length: ClipLength | undefined,
  signal?: AbortSignal
): Promise<HighlightCandidate[]> {
  const range = CLIP_LENGTH_RANGES[length ?? "standard"];
  // words 类走到这里说明是"说话太少/文本通道没产出"触发的,按 reaction 权重兜底
  const weights = MOMENT_WEIGHTS[evidence === "visual" ? "visual" : "reaction"];
  const moments = fuseMoments(signals, transcript.durationSec, {
    weights,
    minSec: range.minSec,
    maxSec: range.maxSec,
  });
  if (moments.length === 0) return [];

  const zh = isChineseTranscript(transcript);
  const content = await chatComplete(
    llm,
    zh ? MOMENT_SYSTEM_PROMPT_ZH : MOMENT_SYSTEM_PROMPT_EN,
    buildMomentPrompt(
      moments.map((m) => ({
        id: m.id,
        startSec: m.startSec,
        endSec: m.endSec,
        evidence: m.evidence,
        text: textInRange(transcript, m.startSec, m.endSec),
      })),
      4,
      zh
    ),
    signal
  );
  return momentsToCandidates(transcript, moments, parseMomentPicks(content));
}
