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
} from "./prompt";
import { resolveSelection, type RawSelection } from "./match";
import { prefilterTranscript } from "./prefilter";

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

/** Drop overlapping candidates, keeping higher scores (they arrive score-sorted). */
export function dropOverlaps(candidates: HighlightCandidate[]): HighlightCandidate[] {
  const kept: HighlightCandidate[] = [];
  for (const c of [...candidates].sort((a, b) => b.score - a.score)) {
    const overlaps = kept.some((k) => c.startSec < k.endSec && c.endSec > k.startSec);
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
  reviewMemory?: ReviewRecord[]
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
    highlightSystemPrompt(promptTranscript, length, products ?? [], reference, reviewMemory),
    buildHighlightPrompt(promptTranscript, 6, signals),
    signal
  );
  const selections = parseSelections(content);

  const { lo, hi } = clipLengthBounds(length);
  const candidates: HighlightCandidate[] = [];
  for (const sel of selections) {
    const resolved = resolveSelection(transcript, sel);
    if (!resolved) continue;
    const dur = resolved.endSec - resolved.startSec;
    if (dur < lo || dur > hi) continue;
    candidates.push({
      id: candidates.length + 1,
      startSec: resolved.startSec,
      endSec: resolved.endSec,
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
  const kept = dropOverlaps(candidates);
  if (kept.length === 0) return { candidates: kept, funnel };

  // Stage 2: adversarial review — a stricter pass judges each clip's hook,
  // completeness and standalone value; weak clips get flagged (not silently
  // dropped) so the UI can default-deselect them and hands-off mode skips
  // them. Fail-open: a broken review call must never take down detection.
  // 复评的上下文用全量转写(不是漏斗后的)——评审要看片段前后文防断章取义。
  try {
    const reviewContent = await chatComplete(
      llm,
      reviewSystemPrompt(transcript),
      buildReviewPrompt(transcript, kept),
      signal
    );
    return { candidates: normalizeScores(applyReviews(kept, parseReviews(reviewContent))), funnel };
  } catch {
    return { candidates: kept, funnel };
  }
}
