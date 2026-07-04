/**
 * Bundled binary resolution (ffmpeg / ffprobe).
 * In dev these come from node_modules; in the packaged app electron-builder
 * unpacks them from asar (see electron-builder.yml asarUnpack), so paths that
 * contain "app.asar" must be rewritten to "app.asar.unpacked".
 */

/** Rewrite an asar-internal path to its unpacked twin (no-op outside asar). Pure. */
export function toUnpackedPath(p: string): string {
  return p.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
}

/** Resolve the ffmpeg binary path (ffmpeg-static). Throws when unavailable. */
export function resolveFfmpegPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ffmpegPath = require("ffmpeg-static") as string | null;
  if (!ffmpegPath) throw new Error("ffmpeg-static did not provide a binary for this platform");
  return toUnpackedPath(ffmpegPath);
}

/** Resolve the ffprobe binary path (@ffprobe-installer). Throws when unavailable. */
export function resolveFfprobePath(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { path } = require("@ffprobe-installer/ffprobe") as { path: string };
  if (!path) throw new Error("@ffprobe-installer/ffprobe did not provide a binary for this platform");
  return toUnpackedPath(path);
}
