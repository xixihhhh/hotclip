/** Shared identity and filter composition for source-picture analysis. */
import {
  hdrToneMapFilter,
  isExecutableColorPlan,
  type ColorRenderPlan,
} from "./color";

export const ANALYSIS_VIDEO_VERSION = "selected-stream-hdr-preview-v1";

export interface AnalysisVideoOptions {
  /** Global ffprobe stream index selected by HotClip for final render. */
  videoStreamIndex?: number;
  /** Source colour plan; only verified executable HDR plans change pixels. */
  color?: ColorRenderPlan | null;
}

/** Prepend the verified HDR→SDR preview transform before analysis filters. */
export function analysisVideoFilter(
  filters: string | string[],
  color?: ColorRenderPlan | null
): string {
  const rest = Array.isArray(filters) ? filters : [filters];
  const preview = hdrToneMapFilter(color);
  return [...(preview ? [preview] : []), ...rest.filter(Boolean)].join(",");
}

/** Stable cache suffix: selected picture and preview colour contract are inseparable. */
export function analysisVideoIdentity(options: AnalysisVideoOptions = {}): string {
  const stream = Number.isInteger(options.videoStreamIndex) && (options.videoStreamIndex ?? -1) >= 0
    ? String(options.videoStreamIndex)
    : "default";
  const color = options.color;
  let colorId = "passthrough-unknown-none";
  if (color) {
    colorId = color.action === "tonemap-bt709" && isExecutableColorPlan(color)
      ? [
        color.detected,
        color.source.primaries,
        color.source.transfer,
        color.source.space,
        color.source.range,
        color.source.peakNits || "auto",
      ].join("-")
      : `passthrough-${color.detected}-${color.reason}`;
  }
  return `${ANALYSIS_VIDEO_VERSION}:v=${stream}:color=${colorId}`;
}
