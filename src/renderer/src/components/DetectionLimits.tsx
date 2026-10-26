import type { ClipLength } from "../../../shared/api-types";
import { CLIP_LENGTH_RANGES } from "../../../shared/detection-options";
import { useT } from "../i18n/store";

/** The same visible length/count controls in the workbench and recording watcher. */
export function DetectionLimits({ clipLength, maxClips, onChange, disabled = false }: {
  clipLength: ClipLength;
  maxClips: number;
  onChange: (value: { clipLength?: ClipLength; maxClips?: number }) => void;
  disabled?: boolean;
}): React.JSX.Element {
  const t = useT("workbench");
  return (
    <div className="space-y-2 text-[12px]">
      <label className="flex items-center justify-between gap-2">
        <span className="text-mut">{t("paramLength")}</span>
        <select aria-label={t("paramLength")} disabled={disabled} value={clipLength}
          onChange={(e) => onChange({ clipLength: e.target.value as ClipLength })}
          className="min-w-0 rounded-lg border border-line bg-panel-2 px-2 py-1.5 disabled:opacity-50">
          {(Object.entries(CLIP_LENGTH_RANGES) as [ClipLength, { minSec: number; maxSec: number }][]).map(([id, range]) => (
            <option key={id} value={id}>{id === "extended" ? t("lengthExtended") : `${range.minSec}–${range.maxSec} ${t("secondsUnit")}`}</option>
          ))}
        </select>
      </label>
      <label className="flex items-center justify-between gap-2">
        <span className="text-mut">{t("paramMaxClips")}</span>
        <select aria-label={t("paramMaxClips")} disabled={disabled} value={maxClips}
          onChange={(e) => onChange({ maxClips: Number(e.target.value) })}
          className="rounded-lg border border-line bg-panel-2 px-2 py-1.5 disabled:opacity-50">
          {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <p className="text-[10.5px] leading-relaxed text-mut/80">{t("selectionLimitsHint")}</p>
    </div>
  );
}
