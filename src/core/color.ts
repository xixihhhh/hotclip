/** Pure HDR detection and render-planning helpers. */
import type { MediaInfo } from "./probe";

export interface ColorMetadata {
  pixelFormat: string;
  bitDepth: number;
  primaries: string;
  transfer: string;
  space: string;
  range: string;
  /** Static signal peak in nits; 0 means absent/untrusted. */
  peakNits: number;
}

export interface ColorRenderPlan {
  source: ColorMetadata;
  detected: "pq" | "hlg" | "sdr" | "unknown";
  action: "tonemap-bt709" | "passthrough";
  output: ColorMetadata | null;
  /** Stable machine-readable explanation for receipts and cache identity. */
  reason: string;
}

/** Detection remains true even when the source cannot be converted safely. */
export function isHdrSource(plan?: ColorRenderPlan | null): boolean {
  return plan?.detected === "pq" || plan?.detected === "hlg";
}

const BT709_OUTPUT: ColorMetadata = {
  pixelFormat: "yuv420p",
  bitDepth: 8,
  primaries: "bt709",
  transfer: "bt709",
  space: "bt709",
  range: "tv",
  peakNits: 100,
};

const UNKNOWN_TRANSFER_VALUES = new Set(["", "unknown", "unspecified", "reserved"]);
const VERIFIED_HDR_RANGES = new Set(["tv", "pc"]);

function hasVerifiedHdrInput(source: ColorMetadata): boolean {
  return (
    source.primaries === "bt2020" &&
    source.space === "bt2020nc" &&
    VERIFIED_HDR_RANGES.has(source.range)
  );
}

/** Defend render helpers against manually constructed or stale plans. */
export function isExecutableColorPlan(plan?: ColorRenderPlan | null): plan is ColorRenderPlan {
  return Boolean(plan && plan.action === "tonemap-bt709" && isHdrSource(plan) && hasVerifiedHdrInput(plan.source));
}

function normalized(value: string | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Plan a color transform from explicit stream metadata only.
 * Pixel format, bit depth, and primaries alone are deliberately insufficient
 * evidence to infer HDR, so missing/ambiguous transfer metadata fails open.
 */
export function planColorRender(info: MediaInfo): ColorRenderPlan {
  const source: ColorMetadata = {
    pixelFormat: normalized(info.pixelFormat),
    bitDepth: Number.isInteger(info.bitDepth) && (info.bitDepth ?? 0) > 0 ? info.bitDepth! : 0,
    primaries: normalized(info.colorPrimaries),
    transfer: normalized(info.colorTransfer),
    space: normalized(info.colorSpace),
    range: normalized(info.colorRange),
    peakNits: Number.isFinite(info.hdrPeakNits) && (info.hdrPeakNits ?? 0) > 0 ? info.hdrPeakNits! : 0,
  };

  const detected =
    source.transfer === "smpte2084"
      ? "pq"
      : source.transfer === "arib-std-b67"
        ? "hlg"
        : UNKNOWN_TRANSFER_VALUES.has(source.transfer)
          ? "unknown"
          : "sdr";

  if (detected === "pq" || detected === "hlg") {
    // zscale cannot reliably derive an input colour path from the transfer tag
    // alone. Missing or unsupported colour tags therefore stay fail-open
    // instead of guessing BT.2020 and risking a failed or incorrect export.
    const hasSafeInputPath = hasVerifiedHdrInput(source);
    if (!hasSafeInputPath) {
      return {
        source,
        detected,
        action: "passthrough",
        output: null,
        reason: `hdr-${detected}-unsupported-color-path-passthrough`,
      };
    }

    return {
      source,
      detected,
      action: "tonemap-bt709",
      output: { ...BT709_OUTPUT },
      reason: `hdr-${detected}-tone-map-bt709`,
    };
  }

  return {
    source,
    detected,
    action: "passthrough",
    output: null,
    reason: detected === "sdr" ? "sdr-transfer-passthrough" : "unknown-transfer-passthrough",
  };
}

/** FFmpeg software tone-map chain, kept as one filter expression for composition. */
export function hdrToneMapFilter(plan?: ColorRenderPlan | null): string | null {
  if (!isExecutableColorPlan(plan)) return null;
  // Static MaxCLL/mastering data wins when present. When absent, omit `peak`
  // so tonemap can still consume decoded-frame side data and retain its own
  // bounded 1000-nit fallback instead of overriding information we missed.
  const signalPeak = plan.source.peakNits > 0
    ? Math.min(100, Math.max(1, plan.source.peakNits / 100))
    : null;
  const peakOption = signalPeak === null ? "" : `:peak=${Number(signalPeak.toFixed(3)).toString()}`;
  return [
    `zscale=pin=${plan.source.primaries}:tin=${plan.source.transfer}:min=${plan.source.space}:rin=${plan.source.range}:t=linear:npl=100`,
    "format=gbrpf32le",
    `tonemap=tonemap=mobius:desat=2${peakOption}`,
    "zscale=p=bt709:t=bt709:m=bt709:r=tv:dither=error_diffusion",
    "format=yuv420p",
  ].join(",");
}

/** Explicit output tags prevent players from interpreting tone-mapped SDR as HDR. */
export function colorOutputArgs(plan?: ColorRenderPlan | null): string[] {
  if (!isExecutableColorPlan(plan)) return [];
  return [
    "-color_primaries", "bt709",
    "-color_trc", "bt709",
    "-colorspace", "bt709",
    "-color_range", "tv",
  ];
}
