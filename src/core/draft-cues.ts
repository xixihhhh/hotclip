/** Editable text copied from the same rendered cue timings as the finished MP4. */
export type DraftRole = "Title" | "Caption" | "Hook" | "Trans" | "Aigc";
export interface DraftLook {
  color: string;
  y: number;
  relativeSize: number;
  border?: { color: string; alpha: number; relativeWidth: number; box: boolean };
}
export interface DraftCue { role: DraftRole; startSec: number; endSec: number; text: string; look?: DraftLook }

function assColor(value: string) {
  const [, aa, bb, gg, rr] = /^&H([A-F\d]{2})([A-F\d]{2})([A-F\d]{2})([A-F\d]{2})$/i.exec(value) ?? [];
  return rr ? { color: `#${rr}${gg}${bb}`, alpha: 1 - parseInt(aa, 16) / 255 } : undefined;
}

function assSeconds(clock: string): number {
  const [hours, minutes, seconds] = clock.split(":").map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}

export function draftCuesFromAss(ass: string): DraftCue[] {
  const cues: DraftCue[] = [];
  const looks = new Map<string, DraftLook>();
  const height = Number(/^PlayResY: (\d+)/m.exec(ass)?.[1]);
  for (const line of ass.split("\n")) {
    if (line.startsWith("Style: ") && height > 0) {
      const fields = line.slice(7).split(",");
      const size = Number(fields[2]);
      const top = Number(fields[18]) >= 7;
      const offset = (Number(fields[21]) + size / 2) / height;
      const border = assColor(fields[5]);
      looks.set(fields[0], {
        color: assColor(fields[3])?.color ?? "#FFFFFF", y: (top ? 1 : -1) * (1 - 2 * offset), relativeSize: size / height,
        border: border && { ...border, box: fields[15] === "3", relativeWidth: Number(fields[16]) / Math.max(1, size) },
      });
      continue;
    }
    const m = /^Dialogue: \d+,([^,]+),([^,]+),(Title|Caption|Hook|Trans|Aigc),[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,(.*)$/.exec(line);
    if (!m) continue;
    const text = m[4].replace(/(?<!\\)\{\\[^}]*\}/g, "").replace(/\\N/g, "\n").replace(/\\([{}\\])/g, "$1");
    if (text.trim()) cues.push({ role: m[3] as DraftRole, startSec: assSeconds(m[1]), endSec: assSeconds(m[2]), text, look: looks.get(m[3]) });
  }
  return cues;
}

/** Trim the boundaries of the post-splice timeline, preserving source coordinates. */
export function trimDraftSegments(segments: Array<{startSec: number; endSec: number}>, trimStart: number, duration: number) {
  let cursor = 0;
  return segments.flatMap((segment) => {
    const length = segment.endSec - segment.startSec;
    const lo = Math.max(0, trimStart - cursor);
    const hi = Math.min(length, trimStart + duration - cursor);
    cursor += length;
    return hi > lo ? [{ startSec: segment.startSec + lo, endSec: segment.startSec + hi }] : [];
  });
}

export function shiftDraftCues(cues: DraftCue[], delta: number, duration: number): DraftCue[] {
  return cues.flatMap((cue) => {
    const startSec = Math.max(0, cue.startSec + delta);
    const endSec = Math.min(duration, cue.endSec + delta);
    return endSec > startSec ? [{ ...cue, startSec, endSec }] : [];
  });
}
