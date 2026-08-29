/**
 * VLM 候选段复核(v0.12):候选定稿后,对每条候选在其时间范围内抽 ≤9 帧拼一张
 * 接触表,让视觉模型看画面回答——画面精彩度、一句话看点、画面与文案是否匹配。
 * 结论回流候选:高画面分小幅加分、信号候选画面死气则小幅降分、看点写进 reason
 * (证据链可审计)。
 *
 * 为什么值得做:纯文本选段"看不见画面"是行业通病(跳舞/萌宠/户外的峰值时刻
 * 文字常常只有"卧槽");OpusClip 的 ClipAnything 是唯一被第三方认可在非口播
 * 内容占优的多模态选段。每条候选一张接触表 = 一次调用,本地 Ollama 免费,
 * 云端(Atlas MiMo/Qwen3-VL)每条几分钱——同一个 OpenAI 兼容通道,零新增基建。
 *
 * 纯函数(抽帧规划/提示词/解析/回流)可单测;网络与拼图经注入点替换。
 * fail-open:单条复核失败跳过该条,整体失败退回原候选——复核只锦上添花。
 */
import type { HighlightCandidate, LlmConfig } from "../../shared/api-types";
import { composeContactSheetJpeg } from "../contact-sheet";
import { stripThinkBlocks } from "./prefilter";
import { sanitizeVisibleText, visionChatComplete, VISION_CALL_TIMEOUT_MS, type VisionChatFn, type VisionConfig, type SheetComposer } from "./vision";

/** 每条候选的抽帧上限(一张 3×3 接触表 = 一次调用)。 */
export const REVIEW_FRAMES_PER_CANDIDATE = 9;
/** 一轮复核最多看多少条候选(按分数取前 N,防长尾浪费额度)。 */
export const REVIEW_MAX_CANDIDATES = 8;
/** 复核总预算(超时带着已得结果收工)。 */
const REVIEW_BUDGET_MS = 120_000;
/** 画面分达到该值起加分(满 10)。 */
export const REVIEW_BOOST_THRESHOLD = 8;
/** 信号候选画面分低于该值降分——信号候选的立身之本就是"画面有货"。 */
export const REVIEW_DEMOTE_THRESHOLD = 3;
/** 加/降分幅度上限:复核是修正不是推翻,文本证据仍是主体。 */
const BOOST_PER_POINT = 4;
const BOOST_MAX = 12;
const DEMOTE_DELTA = 6;

/** 单条候选的复核结论。 */
export interface CandidateReview {
  /** 画面精彩度 0-10。 */
  visual: number;
  /** 一句话画面看点(≤30 字)。 */
  scene: string;
  /** 画面与标题/钩子是否对得上(明显货不对板会标 false)。 */
  match: boolean;
  /** 抽样帧中可以逐字确认的屏显文字;不确定时省略。 */
  visibleText?: string[];
}

export interface ReviewVisionStats {
  reviewed: number;
  boosted: number;
  demoted: number;
}

/**
 * 候选内抽帧:多段拼接按各段时长比例分配帧数(每段至少 1 帧),段内均匀铺;
 * 单段直接均匀铺。帧距各段边缘留 0.3s(边界帧常是转场废帧)。纯函数。
 */
export function planCandidateFrames(
  candidate: Pick<HighlightCandidate, "startSec" | "endSec" | "pieces">,
  maxFrames = REVIEW_FRAMES_PER_CANDIDATE
): number[] {
  const pieces =
    candidate.pieces && candidate.pieces.length > 1
      ? candidate.pieces
      : [{ startSec: candidate.startSec, endSec: candidate.endSec }];
  const total = pieces.reduce((a, p) => a + Math.max(0, p.endSec - p.startSec), 0);
  if (!(total > 0)) return [];
  const times: number[] = [];
  // 按比例分帧(至少 1),多出的额度从头再分一轮
  const quota = pieces.map((p) => Math.max(1, Math.floor((maxFrames * (p.endSec - p.startSec)) / total)));
  let used = quota.reduce((a, b) => a + b, 0);
  for (let i = 0; used > maxFrames && i < quota.length; i++) {
    // 超发时从帧数最多的段回收
    const maxIdx = quota.indexOf(Math.max(...quota));
    if (quota[maxIdx] > 1) {
      quota[maxIdx]--;
      used--;
    } else break;
  }
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    const pad = Math.min(0.3, (p.endSec - p.startSec) / 4);
    const lo = p.startSec + pad;
    const hi = p.endSec - pad;
    const n = quota[i];
    for (let k = 1; k <= n; k++) {
      times.push(lo + ((hi - lo) * k) / (n + 1));
    }
  }
  return times.sort((a, b) => a - b).slice(0, maxFrames);
}

export function reviewSystemPrompt(cellCount: number): string {
  return [
    `你在为短视频切片复核画面。图是同一条候选切片内的 ${cellCount} 帧接触表,`,
    "从左到右、从上到下编号 1 起(多余黑格忽略)。综合所有帧回答:",
    "visual:这条切片的画面精彩度 0-10(夸张表情/激烈动作/冲突互动/场面炸裂高分;静态口播/空镜/PPT 低分);",
    "scene:一句话说出画面最大的看点(≤30字,没有就写画面平淡之处);",
    "match:画面与给出的标题/钩子是否对得上(标题说的东西画面里根本没有 = false)。",
    "visibleText:只抄所有帧里清晰可逐字确认的产品名/价格/比分/标题/PPT要点;不确定或只是推断就给空数组,最多5条。",
    '严格只输出 JSON:{"visual":0-10,"scene":"…","match":true/false,"visibleText":["原样文字"]},不要输出其他内容。',
  ].join("\n");
}

/** 用户提示:带上标题/钩子与转写摘录,模型才能判 match。 */
export function reviewUserPrompt(candidate: Pick<HighlightCandidate, "title" | "hook" | "text">): string {
  const excerpt = (candidate.text ?? "").replace(/\s+/g, " ").slice(0, 160);
  return [
    `候选标题:${candidate.title}`,
    `开场钩子:${candidate.hook}`,
    `转写摘录:${excerpt}`,
    "请按系统要求输出 JSON。",
  ].join("\n");
}

/** 解析复核输出;垃圾输出返回 null(该条按未复核处理)。纯函数。 */
export function parseCandidateReview(content: string): CandidateReview | null {
  const cleaned = stripThinkBlocks(content);
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const rec = obj as { visual?: unknown; scene?: unknown; match?: unknown; visibleText?: unknown };
  const visual = Number(rec.visual);
  if (!Number.isFinite(visual)) return null;
  const visibleText = sanitizeVisibleText(rec.visibleText);
  return {
    visual: Math.max(0, Math.min(10, visual)),
    scene: typeof rec.scene === "string" ? rec.scene.trim().slice(0, 40) : "",
    match: rec.match !== false,
    ...(visibleText.length > 0 ? { visibleText } : {}),
  };
}

/**
 * 复核结论回流候选(纯函数):
 * - visual ≥ 8:每高 1 分加 4 分,封顶 +12、总分 ≤99(画面是真加分项)
 * - boundary="signal" 且 visual ≤ 3:降 6 分,下限 1(信号候选画面死气 = 负证据)
 * - match=false:reason 里显式标注货不对板(不动分——判定尚不稳,先给人看)
 * - scene 写进 reason(证据链);全部重排序按新分。
 */
export function applyCandidateReviews(
  candidates: HighlightCandidate[],
  reviews: Map<number, CandidateReview>
): { candidates: HighlightCandidate[]; stats: ReviewVisionStats } {
  let boosted = 0;
  let demoted = 0;
  const out = candidates.map((c) => {
    const r = reviews.get(c.id);
    if (!r) return c;
    let score = c.score;
    if (r.visual >= REVIEW_BOOST_THRESHOLD) {
      score = Math.min(99, score + Math.min(BOOST_MAX, (r.visual - (REVIEW_BOOST_THRESHOLD - 1)) * BOOST_PER_POINT));
      boosted++;
    } else if (c.boundary === "signal" && r.visual <= REVIEW_DEMOTE_THRESHOLD) {
      score = Math.max(1, score - DEMOTE_DELTA);
      demoted++;
    }
    const notes = [
      r.scene ? `画面复核 ${r.visual}/10:${r.scene}` : `画面复核 ${r.visual}/10`,
      ...(r.visibleText?.length ? [`屏显文字:${r.visibleText.join(" / ")}`] : []),
      ...(r.match ? [] : ["⚠画面与标题可能货不对板"]),
    ].join(";");
    return {
      ...c,
      score,
      reason: c.reason ? `${c.reason};${notes}` : notes,
      visualEvidence: {
        score: r.visual,
        scene: r.scene,
        match: r.match,
        ...(r.visibleText?.length ? { visibleText: r.visibleText } : {}),
      },
    };
  });
  out.sort((a, b) => b.score - a.score);
  return { candidates: out, stats: { reviewed: reviews.size, boosted, demoted } };
}

/**
 * 执行一轮候选复核:按分取前 N 条,各自一张接触表一次调用。
 * fail-open:单条失败跳过;一条都没复核成返回 null(调用方沿用原候选)。
 */
export async function reviewCandidatesVision(opts: {
  videoPath: string;
  candidates: HighlightCandidate[];
  config: VisionConfig;
  signal?: AbortSignal;
  fontFile?: string;
  composeSheet?: SheetComposer;
  chat?: VisionChatFn;
  budgetMs?: number;
  maxCandidates?: number;
}): Promise<{ candidates: HighlightCandidate[]; stats: ReviewVisionStats } | null> {
  const {
    videoPath, candidates, config, signal,
    composeSheet = (v, ts) => composeContactSheetJpeg(v, ts, { fontFile: opts.fontFile }),
    chat = visionChatComplete,
    budgetMs = REVIEW_BUDGET_MS,
    maxCandidates = REVIEW_MAX_CANDIDATES,
  } = opts;
  if (candidates.length === 0) return null;
  const llm: LlmConfig = { baseUrl: config.baseUrl, apiKey: config.apiKey || "ollama", model: config.model };
  const targets = [...candidates].sort((a, b) => b.score - a.score).slice(0, maxCandidates);
  const deadline = Date.now() + budgetMs;
  const reviews = new Map<number, CandidateReview>();
  for (const c of targets) {
    if (signal?.aborted) throw new Error("aborted");
    if (Date.now() > deadline) break;
    const times = planCandidateFrames(c);
    if (times.length === 0) continue;
    const sheet = await composeSheet(videoPath, times);
    if (!sheet) continue;
    try {
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(VISION_CALL_TIMEOUT_MS, deadline - Date.now())));
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const content = await chat(llm, reviewSystemPrompt(times.length), reviewUserPrompt(c), sheet, combined);
      const verdict = parseCandidateReview(content);
      if (verdict) reviews.set(c.id, verdict);
    } catch (e) {
      if (signal?.aborted) throw e;
      // 单条失败不致命,跳过继续
    }
  }
  if (reviews.size === 0) return null;
  return applyCandidateReviews(candidates, reviews);
}
