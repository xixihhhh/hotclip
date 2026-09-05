import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { AlignmentPreview, AlignmentRequest, Transcript, TranscriptWord } from "../shared/api-types";
import { paraformerSupportsText } from "../shared/speech-text";
import { summarizeTimingQuality } from "../shared/transcript-quality";
import { createClipAligner, refineWordTimings, ALIGN_MIN_MATCH_FRAC } from "./align";
import { qwenAlign, qwenHealth, DEFAULT_QWEN_URL } from "./transcribe/qwen-local";
import { extractPcmF32le16k, readF32leSamples } from "./models";
import { resolveFfmpegPath } from "./binaries";

const LANGUAGE_NAMES: Record<string, string> = { Chinese: "zh", English: "en", Cantonese: "yue", French: "fr", German: "de", Italian: "it", Japanese: "ja", Korean: "ko", Portuguese: "pt", Russian: "ru", Spanish: "es" };
export function alignmentLanguage(language: string, text: string): string | null {
  const normalized = LANGUAGE_NAMES[language] ?? language.toLowerCase().split("-")[0];
  if (Object.values(LANGUAGE_NAMES).includes(normalized)) return normalized;
  if (normalized !== "auto") return null;
  if (paraformerSupportsText(text)) return /\p{Script=Han}/u.test(text) ? "zh" : "en";
  return null;
}

/** Preview only. Caller explicitly applies it as one undoable transcript edit. */
export async function previewTranscriptAlignment(
  file: string, transcript: Transcript, request: AlignmentRequest, modelsRoot: string, signal?: AbortSignal,
  injected?: (segment: Transcript["segments"][number]) => Promise<TranscriptWord[] | null>
): Promise<AlignmentPreview> {
  if (!transcript || !Array.isArray(transcript.segments) || !request || !Array.isArray(request.segmentIds) ||
      !["paraformer", "qwen3"].includes(request.engine)) throw new Error("alignment:invalid-request");
  const ids = new Set(request.segmentIds);
  const segments = transcript.segments.filter((segment) => ids.has(segment.id));
  if (!segments.length || segments.length !== ids.size || segments.length > 20 || segments.reduce((n, s) => n + s.endSec - s.startSec, 0) > 300) throw new Error("alignment:batch-limit");
  if (segments.some((s) => !Number.isFinite(s.startSec) || !Number.isFinite(s.endSec) || s.startSec < 0 || s.endSec <= s.startSec ||
      s.endSec > transcript.durationSec + 0.05 || s.endSec - s.startSec > 120 || !Array.isArray(s.words) || !s.words.length || s.text.length > 2000)) throw new Error("alignment:segment-limit");
  signal?.throwIfAborted();
  const result: AlignmentPreview = { segments: [], skipped: [], alignedWords: 0, uncertainWords: 0 };
  const align = createClipAligner(modelsRoot, signal);
  const url = request.localServiceUrl ?? DEFAULT_QWEN_URL;
  let qwenReady = false;
  for (const segment of segments) {
    signal?.throwIfAborted();
    const language = alignmentLanguage(request.language ?? transcript.language, segment.text);
    if (!language || (request.engine === "paraformer" && (!["zh", "en"].includes(language) || !paraformerSupportsText(segment.text)))) {
      result.skipped.push({ id: segment.id, reason: "unsupported-language" });
      continue;
    }
    let words: TranscriptWord[] | null;
    if (injected) words = await injected(segment);
    else if (request.engine === "paraformer") words = (await align(file, segment))?.words ?? null;
    else {
      if (!qwenReady) {
        const health = await qwenHealth(url, signal);
        if (!health.aligner) throw new Error("qwen:aligner-not-loaded");
        qwenReady = true;
      }
      const temp = await mkdtemp(join(tmpdir(), "hotclip-align-review-"));
      try {
        const pcm = join(temp, "audio.f32le");
        await extractPcmF32le16k(resolveFfmpegPath(), file, pcm, { startSec: segment.startSec, durationSec: segment.endSec - segment.startSec }, undefined, signal);
        const refs = (await qwenAlign(url, await readF32leSamples(pcm), segment.text, language, signal))
          .map((w) => ({ ...w, startSec: w.startSec + segment.startSec, endSec: w.endSec + segment.startSec }));
        const refined = refineWordTimings(segment.words, refs);
        words = refined.matchedFrac >= ALIGN_MIN_MATCH_FRAC ? refined.words : null;
      } finally { await rm(temp, { recursive: true, force: true }); }
    }
    if (!words || words.length !== segment.words.length || words.some((w, i) => w.text !== segment.words[i].text)) {
      result.skipped.push({ id: segment.id, reason: "low-match" });
      continue;
    }
    // Calibration cannot steal a neighboring sentence or move a cue boundary.
    const bounded = words.map((w) => ({ ...w, startSec: Math.max(segment.startSec, w.startSec), endSec: Math.min(segment.endSec, w.endSec) }));
    if (bounded.some((w, i) => !Number.isFinite(w.startSec) || !Number.isFinite(w.endSec) || w.endSec <= w.startSec || (i > 0 && w.startSec < bounded[i - 1].endSec - 0.001))) {
      result.skipped.push({ id: segment.id, reason: "invalid-timing" });
      continue;
    }
    const timing = summarizeTimingQuality(bounded);
    result.alignedWords += timing.sourceCounts.aligned ?? 0;
    result.uncertainWords += timing.uncertainWords;
    result.segments.push({ ...segment, words: bounded });
  }
  signal?.throwIfAborted();
  return result;
}
