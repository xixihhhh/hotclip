import type { ClipLength, DetectionOptions } from "./api-types";
import { normalizeGenreId } from "../core/genre";

export const CLIP_LENGTH_RANGES: Record<ClipLength, { minSec: number; maxSec: number }> = {
  short: { minSec: 10, maxSec: 30 },
  standard: { minSec: 8, maxSec: 40 },
  long: { minSec: 40, maxSec: 90 },
  extended: { minSec: 60, maxSec: 120 },
};

export function isClipLength(value: unknown): value is ClipLength {
  return typeof value === "string" && Object.hasOwn(CLIP_LENGTH_RANGES, value);
}

export function normalizeMaxClips(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(12, Math.round(value))) : 6;
}

export function detectionOptionsFromPrefs(prefs: {
  clipLength: ClipLength; maxClips: number; genreId: string; genreCustom: string;
}): DetectionOptions {
  return {
    clipLength: prefs.clipLength,
    maxClips: prefs.maxClips,
    genre: { id: normalizeGenreId(prefs.genreId), custom: prefs.genreCustom },
  };
}
