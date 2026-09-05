import type { ExportProgressEvent } from "./api-types";

/** Completion is confirmed by the export result, not an encoder reaching EOF. */
export function exportProgressPercent(progress: ExportProgressEvent | null): number {
  if (!progress || !Number.isFinite(progress.total) || progress.total <= 0) return 0;
  const fraction = Number.isFinite(progress.fraction) ? Math.max(0, Math.min(1, progress.fraction!)) : 0;
  const completed = progress.stage === "cutting" ? progress.current - 1 + fraction : progress.current;
  if (!Number.isFinite(completed)) return 0;
  return Math.min(99, Math.max(0, Math.round(completed / progress.total * 100)));
}
