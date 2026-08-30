/** Capability-specific adapters over the generic evidence index. */
import { createHash } from "crypto";
import type { FileFingerprint } from "./render-cache";
import {
  fingerprintEvidenceSource,
  readEvidence,
  writeEvidence,
} from "./evidence-index";
import { collectSignals, type MediaSignals, type MotionSample, type TimeRange } from "./signals";
import { MAX_VISUAL_SIGNAL_SAMPLES, type VisualSignalSample } from "./visual-enhance";
import { detectShotBoundaries } from "./shots";
import {
  collectVisionSignal,
  type VisionConfig,
  type VisionOutcome,
  type VisionChatFn,
  type SheetComposer,
} from "./highlight/vision";
import { analysisVideoIdentity, type AnalysisVideoOptions } from "./analysis-video";

export const TIER0_EVIDENCE_CAPABILITY = "tier0-signals-v3";
const SHOT_EVIDENCE_VERSION = "transnetv2-v1";
const VISION_EVIDENCE_VERSION = "contact-sheet-v3-visible-text";

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validRanges(value: unknown, max = 64): value is TimeRange[] {
  return Array.isArray(value) && value.length <= max && value.every((range) => {
    if (!range || typeof range !== "object") return false;
    const item = range as Partial<TimeRange>;
    return finite(item.startSec) && finite(item.endSec) && item.startSec >= 0 && item.endSec >= item.startSec;
  });
}

function validMotion(value: unknown, max: number): value is MotionSample[] {
  return Array.isArray(value) && value.length <= max && value.every((sample) => {
    if (!sample || typeof sample !== "object") return false;
    const item = sample as Partial<MotionSample>;
    return finite(item.t) && item.t >= 0 && finite(item.score) && item.score >= 0 && item.score <= 1;
  });
}

function validLoudness(value: unknown): value is Array<{ t: number; m: number }> {
  return Array.isArray(value) && value.length <= 250_000 && value.every((sample) => {
    if (!sample || typeof sample !== "object") return false;
    const item = sample as { t?: unknown; m?: unknown };
    return finite(item.t) && item.t >= 0 && finite(item.m);
  });
}

function validVisualSamples(value: unknown): value is VisualSignalSample[] {
  return Array.isArray(value) && value.length <= MAX_VISUAL_SIGNAL_SAMPLES && value.every((sample) => {
    if (!sample || typeof sample !== "object") return false;
    const item = sample as Partial<VisualSignalSample>;
    return finite(item.t) && item.t >= 0 && finite(item.yLow) && finite(item.yAvg) &&
      finite(item.yHigh) && finite(item.satAvg) && item.yLow >= 0 && item.yHigh <= 255 &&
      item.yLow <= item.yAvg && item.yAvg <= item.yHigh && item.satAvg >= 0 && item.satAvg <= 255;
  });
}

export function validMediaSignals(value: unknown): value is MediaSignals {
  if (!value || typeof value !== "object") return false;
  const signals = value as Partial<MediaSignals>;
  return validRanges(signals.loudPeaks) && validRanges(signals.cutDense) &&
    (signals.motionPeaks === undefined || validRanges(signals.motionPeaks)) &&
    (signals.motionSamples === undefined || validMotion(signals.motionSamples, 50_000)) &&
    (signals.activityKeyframes === undefined || validMotion(signals.activityKeyframes, 128)) &&
    (signals.visualSamples === undefined || validVisualSamples(signals.visualSamples)) &&
    (signals.loudnessSamples === undefined || validLoudness(signals.loudnessSamples));
}

export async function collectSignalsEvidence(opts: {
  videoPath: string;
  evidenceDir?: string;
  signal?: AbortSignal;
  source?: FileFingerprint;
  collect?: typeof collectSignals;
  analysis?: AnalysisVideoOptions;
}): Promise<MediaSignals> {
  opts.signal?.throwIfAborted();
  const collect = opts.collect ?? collectSignals;
  if (!opts.evidenceDir) return collect(opts.videoPath, opts.signal, opts.analysis);
  const source = opts.source ?? await fingerprintEvidenceSource(opts.videoPath);
  const capability = `${TIER0_EVIDENCE_CAPABILITY}:${analysisVideoIdentity(opts.analysis)}`;
  const cached = await readEvidence(opts.evidenceDir, source, capability, validMediaSignals);
  opts.signal?.throwIfAborted();
  if (cached) return cached;
  const value = await collect(opts.videoPath, opts.signal, opts.analysis);
  opts.signal?.throwIfAborted();
  await writeEvidence(opts.evidenceDir, source, capability, value).catch(() => false);
  return value;
}

function validBoundaries(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= 250_000 && value.every((time) => finite(time) && time >= 0);
}

export async function detectShotBoundariesEvidence(opts: {
  videoPath: string;
  startSec: number;
  endSec: number;
  modelsRoot: string;
  evidenceDir?: string;
  signal?: AbortSignal;
  source?: FileFingerprint;
  detect?: typeof detectShotBoundaries;
  analysis?: AnalysisVideoOptions;
}): Promise<number[]> {
  opts.signal?.throwIfAborted();
  const detect = opts.detect ?? detectShotBoundaries;
  if (!opts.evidenceDir) return detect(opts.videoPath, opts.startSec, opts.endSec, opts.modelsRoot, opts.signal, opts.analysis);
  const source = opts.source ?? await fingerprintEvidenceSource(opts.videoPath);
  const range = `${Math.round(opts.startSec * 1000)}-${Math.round(opts.endSec * 1000)}`;
  const capability = `shots:${SHOT_EVIDENCE_VERSION}:${analysisVideoIdentity(opts.analysis)}:${range}`;
  const cached = await readEvidence(opts.evidenceDir, source, capability, validBoundaries);
  opts.signal?.throwIfAborted();
  if (cached) return cached;
  const value = await detect(opts.videoPath, opts.startSec, opts.endSec, opts.modelsRoot, opts.signal, opts.analysis);
  opts.signal?.throwIfAborted();
  await writeEvidence(opts.evidenceDir, source, capability, value).catch(() => false);
  return value;
}

function visionIdentity(config: VisionConfig, scan: boolean, analysis?: AnalysisVideoOptions): string {
  const endpoint = config.baseUrl.replace(/\/+$/, "").toLowerCase();
  const model = config.model.trim();
  const digest = createHash("sha256").update(`${endpoint}\n${model}`).digest("hex").slice(0, 20);
  return `vision:${VISION_EVIDENCE_VERSION}:${analysisVideoIdentity(analysis)}:${scan ? "full" : "quick"}:${digest}`;
}

function validVisionOutcome(value: unknown): value is VisionOutcome {
  if (!value || typeof value !== "object") return false;
  const outcome = value as Partial<VisionOutcome>;
  if (!validRanges(outcome.visualPeaks) || !Array.isArray(outcome.visualNotes) || outcome.visualNotes.length > 64) return false;
  if (!outcome.visualNotes.every((note) => note && typeof note === "object" && finite(note.t) && note.t >= 0 && finite(note.energy) && typeof note.note === "string" && note.note.length <= 80 &&
    (note.visibleText === undefined || (Array.isArray(note.visibleText) && note.visibleText.length <= 5 && note.visibleText.every((text) => typeof text === "string" && text.length <= 40))))) return false;
  const stats = outcome.stats as Partial<VisionOutcome["stats"]> | undefined;
  return !!stats && finite(stats.framesTotal) && finite(stats.framesScored) && finite(stats.peakCount);
}

export async function collectVisionEvidence(opts: {
  videoPath: string;
  durationSec: number;
  config: VisionConfig;
  signals?: MediaSignals;
  signal?: AbortSignal;
  fontFile?: string;
  composeSheet?: SheetComposer;
  chat?: VisionChatFn;
  budgetMs?: number;
  scan?: boolean;
  evidenceDir?: string;
  source?: FileFingerprint;
  analysis?: AnalysisVideoOptions;
}): Promise<VisionOutcome | null> {
  opts.signal?.throwIfAborted();
  if (!opts.evidenceDir) return collectVisionSignal(opts);
  const source = opts.source ?? await fingerprintEvidenceSource(opts.videoPath);
  const capability = visionIdentity(opts.config, opts.scan === true, opts.analysis);
  const cached = await readEvidence(opts.evidenceDir, source, capability, validVisionOutcome);
  opts.signal?.throwIfAborted();
  if (cached) return cached;
  const value = await collectVisionSignal(opts);
  opts.signal?.throwIfAborted();
  if (value) await writeEvidence(opts.evidenceDir, source, capability, value).catch(() => false);
  return value;
}
