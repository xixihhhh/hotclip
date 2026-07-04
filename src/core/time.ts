/**
 * Time utilities shared across the clipping pipeline.
 * Pure functions — unit-testable without any binary or I/O.
 */

/** Format seconds as "HH:MM:SS" (or "MM:SS" when under an hour). */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "00:00";
  const s = Math.floor(totalSeconds);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Format seconds as an ffmpeg-compatible "HH:MM:SS.mmm" timestamp. */
export function toFfmpegTime(totalSeconds: number): string {
  const clamped = Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : 0;
  const ms = Math.round(clamped * 1000);
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  const mmm = String(millis).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${mmm}`;
}

/**
 * Parse a loose timestamp string into seconds.
 * Accepts "SS", "MM:SS", "HH:MM:SS", each part optionally fractional.
 * Returns null for anything unparsable (never throws — caller decides fallback).
 */
export function parseTimestamp(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":");
  if (parts.length > 3) return null;
  let seconds = 0;
  for (const part of parts) {
    if (!/^\d+(\.\d+)?$/.test(part)) return null;
    seconds = seconds * 60 + Number(part);
  }
  return seconds;
}
