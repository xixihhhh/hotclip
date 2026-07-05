/**
 * Face-aware vertical reframing orchestrator: sample frames in the clip →
 * YuNet detection → shot-aware crop planning. Returns null whenever tracking
 * can't be trusted (no faces, tiny source, model unavailable) — callers fall
 * back to the plain center crop, so this can never make output WORSE.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { resolveFfmpegPath } from "../binaries";
import { probeMedia } from "../probe";
import { ensureModel, YUNET_MODEL } from "../models";
import { parseShowinfoTimes } from "../signals";
import { YunetDetector, YUNET_INPUT, pickMainFace, type FaceBox } from "./yunet";
import { planCropTrack, renderSendcmd, renderCropXExpr, type FaceSample, type CropKeyframe } from "./track";

const execFileAsync = promisify(execFile);

/** Detection sampling rate inside the clip. */
const SAMPLE_FPS = 3;

export interface CropPlan {
  /** sendcmd keyframes (clip-relative time, crop-left-edge px). */
  keyframes: CropKeyframe[];
  cropW: number;
  cropH: number;
  cropY: number;
  /** First keyframe x — the crop's initial position. */
  x0: number;
}

export { renderSendcmd, renderCropXExpr };

/**
 * Build a face-tracking crop plan for one clip. `uiCrop` fractions (when the
 * screen-UI trim is active) are folded into the SAME crop so the whole
 * reframe stays one filter instance driven by sendcmd.
 */
export async function generateCropPlan(
  inputPath: string,
  clipStartSec: number,
  clipEndSec: number,
  modelsRoot: string,
  uiCrop?: { topFrac: number; bottomFrac: number }
): Promise<CropPlan | null> {
  const info = await probeMedia(inputPath);
  if (!info.hasVideo || info.width <= 0 || info.height <= 0) return null;

  const top = uiCrop?.topFrac ?? 0;
  const bottom = uiCrop?.bottomFrac ?? 0;
  const cropY = Math.floor((info.height * top) / 2) * 2;
  const cropH = Math.floor((info.height * Math.max(0.2, 1 - top - bottom)) / 2) * 2;
  const cropW = Math.floor((cropH * 9) / 16 / 2) * 2;
  if (cropW >= info.width) return null; // already narrower than 9:16

  await ensureModel(modelsRoot, YUNET_MODEL);
  const detector = new YunetDetector(modelsRoot);
  await detector.init();

  const dur = clipEndSec - clipStartSec;
  const ffmpeg = resolveFfmpegPath();

  // Letterboxed 640×640 frames — anisotropic stretching skews YuNet's box
  // centers toward the frame middle (verified on a 3x-squeezed synthetic),
  // so keep the aspect ratio and undo the padding when mapping back.
  const s = Math.min(YUNET_INPUT / info.width, YUNET_INPUT / info.height);
  const scaledW = Math.round(info.width * s);
  const padX = Math.floor((YUNET_INPUT - scaledW) / 2);
  const { stdout } = await execFileAsync(
    ffmpeg,
    [
      "-hide_banner", "-v", "error",
      "-ss", String(clipStartSec), "-i", inputPath, "-t", String(dur),
      "-vf",
      `fps=${SAMPLE_FPS},scale=${YUNET_INPUT}:${YUNET_INPUT}:force_original_aspect_ratio=decrease,pad=${YUNET_INPUT}:${YUNET_INPUT}:(ow-iw)/2:(oh-ih)/2:black`,
      "-f", "rawvideo", "-pix_fmt", "bgr24", "-",
    ],
    { encoding: "buffer", maxBuffer: 1024 * 1024 * 1024 }
  );
  const frameBytes = YUNET_INPUT * YUNET_INPUT * 3;
  const samples: FaceSample[] = [];
  let prevMain: FaceBox | null = null;
  for (let off = 0, idx = 0; off + frameBytes <= stdout.length; off += frameBytes, idx++) {
    const faces = await detector.detect(new Uint8Array(stdout.subarray(off, off + frameBytes)));
    const main = pickMainFace(faces, prevMain);
    prevMain = main;
    samples.push({
      t: idx / SAMPLE_FPS,
      cx: main ? Math.min(1, Math.max(0, (main.x + main.w / 2 - padX) / scaledW)) : null,
    });
  }

  // shot cuts inside the clip (clip-relative)
  const sceneErr = await execFileAsync(
    ffmpeg,
    [
      "-hide_banner",
      "-ss", String(clipStartSec), "-i", inputPath, "-t", String(dur), "-an",
      "-vf", "fps=6,scale=160:-2,select='gt(scene,0.3)',showinfo",
      "-f", "null", "-",
    ],
    { maxBuffer: 64 * 1024 * 1024 }
  ).then((r) => r.stderr, () => "");
  const cuts = parseShowinfoTimes(sceneErr);

  const keyframes = planCropTrack(samples, cuts, info.width, cropH);
  if (!keyframes) return null;
  return { keyframes, cropW, cropH, cropY, x0: keyframes[0].x };
}

/** Map a clip-relative source time onto the jump-cut output timeline (null = spliced out). */
export function mapToOutputTime(
  tClipRel: number,
  segments: Array<{ startSec: number; endSec: number }>,
  clipStartSec: number
): number | null {
  const tAbs = tClipRel + clipStartSec;
  let out = 0;
  for (const seg of segments) {
    if (tAbs < seg.startSec) return null;
    if (tAbs <= seg.endSec) return out + (tAbs - seg.startSec);
    out += seg.endSec - seg.startSec;
  }
  return null;
}
