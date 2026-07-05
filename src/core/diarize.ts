/**
 * Speaker diarization — "who is speaking when". Layer 1 of the multi-speaker
 * stack: audio-only turns from pyannote segmentation + 3D-Speaker embeddings
 * (both shipped through sherpa-onnx, zero new runtimes). Downstream consumers:
 * per-speaker caption colors, speaker labels in the highlight prompt, and
 * reframe retarget timing. Word labeling uses whisperX's max-overlap rule.
 */
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { resolveFfmpegPath } from "./binaries";
import { modelDir, SEGMENTATION_MODEL, SPEAKER_EMBEDDING_MODEL } from "./models";
import type { Transcript, TranscriptSegment, TranscriptWord } from "../shared/api-types";

const execFileAsync = promisify(execFile);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sherpa: any = null;
/** sherpa-onnx-node is a native addon — require lazily so importing core stays cheap. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadSherpa(): any {
  if (!sherpa) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sherpa = require("sherpa-onnx-node");
  }
  return sherpa;
}

export interface SpeakerTurn {
  startSec: number;
  endSec: number;
  /** 0-based cluster id; stable within one run, not across runs. */
  speaker: number;
}

export interface DiarizeOptions {
  /** Known speaker count; omit/-1 = discover via clustering threshold. */
  numSpeakers?: number;
  /** Clustering distance threshold when discovering (lower = more speakers). */
  threshold?: number;
  signal?: AbortSignal;
}

/** Decode [0..durationSec] (or the whole file) to 16k mono float32 [-1, 1]. */
async function decodeAudioF32(filePath: string, sampleRate: number): Promise<Float32Array> {
  const { stdout } = await execFileAsync(
    resolveFfmpegPath(),
    ["-hide_banner", "-i", filePath, "-vn", "-ac", "1", "-ar", String(sampleRate), "-f", "s16le", "-"],
    { encoding: "buffer", maxBuffer: 2 * 1024 * 1024 * 1024 - 1 }
  );
  const buf = stdout as unknown as Buffer;
  const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}

/** Run speaker diarization over the file's full audio track. */
export async function runDiarization(
  filePath: string,
  modelsRoot: string,
  options: DiarizeOptions = {}
): Promise<SpeakerTurn[]> {
  const { OfflineSpeakerDiarization } = loadSherpa();
  const sd = new OfflineSpeakerDiarization({
    segmentation: {
      pyannote: { model: join(modelDir(modelsRoot, SEGMENTATION_MODEL), "model.onnx") },
      numThreads: 2,
    },
    embedding: {
      model: join(modelDir(modelsRoot, SPEAKER_EMBEDDING_MODEL), "model.onnx"),
      numThreads: 2,
    },
    clustering: {
      numClusters: options.numSpeakers && options.numSpeakers > 0 ? options.numSpeakers : -1,
      threshold: options.threshold ?? 0.8,
    },
    minDurationOn: 0.3,
    minDurationOff: 0.5,
  });
  const samples = await decodeAudioF32(filePath, sd.sampleRate);
  if (options.signal?.aborted) throw new Error("diarization cancelled");
  const segments = sd.process(samples) as Array<{ start: number; end: number; speaker: number }>;
  return segments
    .map((s) => ({ startSec: s.start, endSec: s.end, speaker: s.speaker }))
    .sort((a, b) => a.startSec - b.startSec);
}

/** Overlap length between a word and a turn, in seconds. */
function overlap(w: TranscriptWord, t: SpeakerTurn): number {
  return Math.max(0, Math.min(w.endSec, t.endSec) - Math.max(w.startSec, t.startSec));
}

/**
 * Label each word with the speaker whose turn overlaps it most (whisperX's
 * assign_word_speakers rule). Words with no overlapping turn adopt the
 * nearest turn within `maxGapSec`, else stay unlabeled.
 */
export function assignWordSpeakers(
  words: TranscriptWord[],
  turns: SpeakerTurn[],
  maxGapSec = 0.5
): TranscriptWord[] {
  if (turns.length === 0) return words;
  return words.map((w) => {
    let best: SpeakerTurn | null = null;
    let bestOverlap = 0;
    for (const t of turns) {
      const o = overlap(w, t);
      if (o > bestOverlap) {
        bestOverlap = o;
        best = t;
      }
    }
    if (!best) {
      let nearest: SpeakerTurn | null = null;
      let nearestGap = Infinity;
      for (const t of turns) {
        const gap = w.startSec > t.endSec ? w.startSec - t.endSec : t.startSec - w.endSec;
        if (gap < nearestGap) {
          nearestGap = gap;
          nearest = t;
        }
      }
      if (nearest && nearestGap <= maxGapSec) best = nearest;
    }
    return best ? { ...w, speaker: best.speaker } : w;
  });
}

/** Count distinct speakers in a turn list. */
export function speakerCount(turns: SpeakerTurn[]): number {
  return new Set(turns.map((t) => t.speaker)).size;
}

/** The speaker owning the most word-time in a segment (majority vote). */
export function dominantSpeaker(words: TranscriptWord[]): number | undefined {
  const byId = new Map<number, number>();
  for (const w of words) {
    if (w.speaker === undefined) continue;
    byId.set(w.speaker, (byId.get(w.speaker) ?? 0) + (w.endSec - w.startSec));
  }
  let best: number | undefined;
  let bestDur = 0;
  for (const [id, dur] of byId) {
    if (dur > bestDur) {
      bestDur = dur;
      best = id;
    }
  }
  return best;
}

/**
 * Label a whole transcript: assign each word a speaker (max-overlap), then set
 * each segment's dominant speaker. Returns a new transcript; the original is
 * untouched. Words already carry the labeling for caption coloring downstream.
 */
export function labelTranscript(transcript: Transcript, turns: SpeakerTurn[]): Transcript {
  if (turns.length === 0) return transcript;
  const segments: TranscriptSegment[] = transcript.segments.map((seg) => {
    const words = assignWordSpeakers(seg.words, turns);
    return { ...seg, words, speaker: dominantSpeaker(words) };
  });
  return { ...transcript, segments };
}
