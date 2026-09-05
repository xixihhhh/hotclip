/**
 * Web-caption overlay renderer: drives a transparent offscreen BrowserWindow
 * through deterministic per-frame seeks and composites the captured BGRA
 * frames onto the base clip with ffmpeg. This is the "ffmpeg owns the video,
 * Chromium owns the typography" split — the overlay page is pure DOM, so CSS
 * effects libass cannot express (gradients, springs, emoji) come for free.
 */
import { BrowserWindow, app } from "electron";
import { withAtomicOutput } from "../core/atomic-output";
import { spawn } from "child_process";
import { join } from "path";
import { resolveFfmpegPath } from "../core/binaries";
import { colorOutputArgs } from "../core/color";
import { ffmpegAudioStreamSpecifier, ffmpegVideoStreamSpecifier } from "../core/probe";
import type { OverlayOutputOptions, OverlayPayload } from "../core/caption-overlay/payload";

export interface OverlayRenderOptions extends OverlayOutputOptions {
  fps?: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** Template directory: extraResources when packaged, repo resources in dev. */
export function templateDir(): string {
  if (process.env.HOTCLIP_TEMPLATE_DIR) return process.env.HOTCLIP_TEMPLATE_DIR;
  return app.isPackaged
    ? join(process.resourcesPath, "caption-templates")
    : join(app.getAppPath(), "resources", "caption-templates");
}

/**
 * Composite `payload` captions over `basePath` into `outPath`.
 * The base clip must already be at the payload's exact resolution.
 */
export async function renderCaptionOverlay(
  basePath: string,
  outPath: string,
  payload: OverlayPayload,
  durationSec: number,
  template = "bubble",
  options: OverlayRenderOptions = {}
): Promise<void> {
  return withAtomicOutput(outPath, (temporaryPath) => renderOverlayToFile(basePath, temporaryPath, payload, durationSec, template, options), options.signal);
}

async function renderOverlayToFile(
  basePath: string,
  outPath: string,
  payload: OverlayPayload,
  durationSec: number,
  template: string,
  options: OverlayRenderOptions
): Promise<void> {
  const { fps = 30, onProgress, signal } = options;
  signal?.throwIfAborted();
  const { width, height } = payload;
  const baseVideo = ffmpegVideoStreamSpecifier(options.videoStreamIndex);

  const win = new BrowserWindow({
    show: false,
    width,
    height,
    frame: false,
    transparent: true,
    enableLargerThanScreen: true,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
    },
  });
  let stopEncoder: (() => Promise<void>) | undefined;
  const closeWindow = (): void => { if (!win.isDestroyed()) win.destroy(); };
  signal?.addEventListener("abort", closeWindow, { once: true });
  try {
    win.setContentSize(width, height);
    // template = a bundled name ("bubble") or an absolute .html path (tests)
    const tplPath = template.endsWith(".html") ? template : join(templateDir(), `${template}.html`);
    await win.loadFile(tplPath);
    await win.webContents.executeJavaScript(
      `__hotclip_load(${JSON.stringify(payload)}); document.fonts.ready.then(() => true)`,
      true
    );

    signal?.throwIfAborted();
    const ffmpeg = spawn(
      resolveFfmpegPath(),
      [
        "-hide_banner",
        "-y",
        "-i",
        basePath,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgra",
        "-video_size",
        `${width}x${height}`,
        "-framerate",
        String(fps),
        "-i",
        "pipe:0",
        // Chromium hands back premultiplied alpha; overlay expects straight.
        "-filter_complex",
        `[1:v:0]unpremultiply=inplace=1[ov];[${baseVideo}][ov]overlay=eof_action=pass[vout]`,
        "-map",
        "[vout]",
        "-map",
        ffmpegAudioStreamSpecifier(options.audioStreamIndex, 0, true),
        "-c:a",
        "copy",
        "-c:v",
        "libx264",
        "-crf",
        "19",
        "-preset",
        "medium",
        ...(options.color?.action === "tonemap-bt709" ? ["-pix_fmt", "yuv420p"] : []),
        ...colorOutputArgs(options.color),
        "-movflags",
        "+faststart",
        outPath,
      ],
      { stdio: ["pipe", "ignore", "pipe"], signal }
    );
    let ffmpegErr = "";
    ffmpeg.stderr.on("data", (d: Buffer) => {
      ffmpegErr = (ffmpegErr + d.toString()).slice(-4000);
    });
    let closed = false;
    let processError: Error | undefined;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    const forceStop = (): void => {
      abortTimer = setTimeout(() => ffmpeg.kill("SIGKILL"), 2000);
      abortTimer.unref();
    };
    signal?.addEventListener("abort", forceStop, { once: true });
    // Settle to a value: early exit must not create an unhandled rejection
    // while Chromium is still capturing a frame.
    const ffmpegDone = new Promise<Error | null>((resolve) => {
      ffmpeg.on("close", (code) => {
        closed = true;
        if (abortTimer) clearTimeout(abortTimer);
        signal?.removeEventListener("abort", forceStop);
        resolve(processError ?? (code === 0 ? null : new Error(`overlay ffmpeg exited ${code}: ${ffmpegErr.slice(-500)}`)));
      });
      ffmpeg.on("error", (error) => { processError = error; });
    });
    ffmpeg.stdin.on("error", () => { /* write callbacks and close own failure reporting */ });
    stopEncoder = async (): Promise<void> => {
      if (closed) return;
      ffmpeg.stdin.destroy();
      ffmpeg.kill("SIGTERM");
      const timer = setTimeout(() => ffmpeg.kill("SIGKILL"), 2000);
      timer.unref();
      try { await ffmpegDone; } finally { clearTimeout(timer); }
    };

    const writeFrame = (buf: Buffer): Promise<void> =>
      new Promise((resolve, reject) => {
        ffmpeg.stdin.write(buf, (err) => (err ? reject(err) : resolve()));
      });

    const totalFrames = Math.ceil(durationSec * fps);
    const expectedBytes = width * height * 4;
    for (let f = 0; f < totalFrames; f++) {
      if (signal?.aborted) throw new Error("overlay render cancelled");
      const tMs = (f * 1000) / fps;
      await win.webContents.executeJavaScript(`__hotclip_seek(${tMs}); true`, true);
      let image = await win.webContents.capturePage();
      // Retina displays capture at 2x; normalise back to frame pixels.
      let bitmap = image.toBitmap();
      if (bitmap.byteLength !== expectedBytes) {
        image = image.resize({ width, height });
        bitmap = image.toBitmap();
      }
      if (bitmap.byteLength !== expectedBytes) {
        throw new Error(`overlay frame size mismatch: got ${bitmap.byteLength}, want ${expectedBytes}`);
      }
      await writeFrame(bitmap);
      if (f % 15 === 0) onProgress?.(f / totalFrames);
    }
    ffmpeg.stdin.end();
    const encoderError = await ffmpegDone;
    signal?.throwIfAborted();
    if (encoderError) throw encoderError;
    onProgress?.(1);
  } finally {
    await stopEncoder?.();
    signal?.removeEventListener("abort", closeWindow);
    closeWindow();
  }
}
