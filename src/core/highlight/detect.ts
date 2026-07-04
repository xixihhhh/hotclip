/**
 * Highlight detection orchestrator: transcript → LLM selections → reverse
 * matching → validated HighlightCandidate list.
 */
import type { Transcript } from "../transcribe/types";
import type { HighlightCandidate, LlmConfig } from "../../shared/api-types";
import { highlightSystemPrompt, buildHighlightPrompt, extractJson } from "./prompt";
import { resolveSelection, type RawSelection } from "./match";

const MIN_CLIP_SEC = 5;
const MAX_CLIP_SEC = 75;

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
    });
  }
  return out;
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

/** Full detection pass. */
export async function detectHighlights(
  transcript: Transcript,
  llm: LlmConfig,
  signal?: AbortSignal
): Promise<HighlightCandidate[]> {
  if (transcript.segments.length === 0) return [];
  const content = await chatComplete(llm, highlightSystemPrompt(transcript), buildHighlightPrompt(transcript), signal);
  const selections = parseSelections(content);

  const candidates: HighlightCandidate[] = [];
  for (const sel of selections) {
    const resolved = resolveSelection(transcript, sel);
    if (!resolved) continue;
    const dur = resolved.endSec - resolved.startSec;
    if (dur < MIN_CLIP_SEC || dur > MAX_CLIP_SEC) continue;
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
    });
  }
  return dropOverlaps(candidates);
}
