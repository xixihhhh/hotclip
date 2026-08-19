/**
 * 候选密排表:一行一条,肥卡片的信息量压进 40px——分数/标题/时码/四维/
 * 质量门一屏对比十几条。点行聚焦(右栏出详情),勾选框决定出片。
 * AI 判弃的折叠到列表末尾,展开才显示(可手动捞回)。
 */
import { useState } from "react";
import { LuCheck, LuChevronDown, LuScissorsLineDashed, LuBookmark, LuTextSelect, LuTriangleAlert, LuBan } from "react-icons/lu";
import { useT } from "../../i18n/store";
import { clipDurationSec, isStitched } from "../../../../shared/pieces";
import type { HighlightCandidate } from "../../../../shared/api-types";

function formatClock(totalSeconds: number): string {
  const s = Math.floor(totalSeconds);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function DimBars({ c }: { c: HighlightCandidate }): React.JSX.Element | null {
  if (!c.scoreDims) return null;
  const dims = [c.scoreDims.hook, c.scoreDims.flow, c.scoreDims.value, c.scoreDims.trend];
  return (
    <span className="flex w-full items-center gap-1">
      {dims.map((v, i) => (
        <span key={i} className="relative h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-line">
          <span
            className={`absolute inset-y-0 left-0 rounded-full ${c.recommended ? "flame-gradient" : "bg-mut/50"}`}
            style={{ width: `${Math.min(100, Math.max(0, v))}%` }}
          />
        </span>
      ))}
    </span>
  );
}

export function CandidateTable({
  candidates,
  selected,
  focusedId,
  onFocus,
  onToggle,
}: {
  candidates: HighlightCandidate[];
  selected: Set<number>;
  focusedId: number | null;
  onFocus: (id: number) => void;
  onToggle: (id: number) => void;
}): React.JSX.Element {
  const t = useT("workbench");
  const th = useT("highlights");
  const [showDropped, setShowDropped] = useState(false);
  const kept = candidates.filter((c) => c.gate !== "drop");
  const dropped = candidates.filter((c) => c.gate === "drop");
  const rows = showDropped ? [...kept, ...dropped] : kept;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line/60 bg-panel/60">
      {/* 表头 */}
      <div className="flex h-7 shrink-0 items-center gap-2.5 border-b border-line/60 px-3 text-[10px] font-bold tracking-wide text-mut/60 select-none">
        <span className="w-5" />
        <span className="w-8">{t("colScore")}</span>
        <span className="min-w-0 flex-1">{t("colTitle")}</span>
        <span className="w-[118px]">{t("colTime")}</span>
        <span className="w-9">{t("colDur")}</span>
        <span className="hidden w-[104px] xl:block">{t("colDims")}</span>
        <span className="w-[52px]">{t("colGate")}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.map((c) => {
          const on = selected.has(c.id);
          const focused = c.id === focusedId;
          const isDrop = c.gate === "drop";
          return (
            <div
              key={c.id}
              onClick={() => onFocus(c.id)}
              className={`flex h-10 cursor-pointer items-center gap-2.5 border-b border-line/30 px-3 transition-colors ${
                focused ? "border-l-2 border-l-flame bg-ember/8" : "border-l-2 border-l-transparent hover:bg-panel-2/60"
              } ${isDrop || !on ? "opacity-60" : ""}`}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(c.id);
                }}
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                  on ? "flame-gradient border-transparent text-white" : "border-line text-transparent hover:border-mut"
                }`}
              >
                <LuCheck className="h-3 w-3" />
              </button>
              <span className={`w-8 shrink-0 font-mono text-[13px] font-extrabold tabular-nums ${c.score >= 85 ? "flame-text" : c.score > 0 ? "text-ember/90" : "text-mut"}`}>
                {c.score > 0 ? c.score : "—"}
              </span>
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className={`truncate text-[12.5px] ${focused ? "font-bold" : "font-semibold text-fg/90"}`}>{c.title}</span>
                {c.score === 0 && (
                  <span className="chip inline-flex shrink-0 items-center gap-0.5 rounded px-1 text-[9px] text-mut">
                    <LuTextSelect className="h-2.5 w-2.5" />
                    {th("manualChip")}
                  </span>
                )}
                {isStitched(c.pieces) && (
                  <LuScissorsLineDashed className="h-3 w-3 shrink-0 text-ember/80" title={th("stitchedChip", { n: c.pieces!.length })} />
                )}
                {c.utility && <LuBookmark className="h-3 w-3 shrink-0 text-sky-400/80" title={th("saveWorthyChip")} />}
              </span>
              <span className="w-[118px] shrink-0 font-mono text-[10.5px] text-mut tabular-nums">
                {formatClock(c.startSec)} → {formatClock(c.endSec)}
              </span>
              <span className="w-9 shrink-0 font-mono text-[10.5px] text-mut tabular-nums">{Math.round(clipDurationSec(c))}s</span>
              <span className="hidden w-[104px] shrink-0 xl:block">
                <DimBars c={c} />
              </span>
              <span className="w-[52px] shrink-0">
                {isDrop ? (
                  <span title={(c.gateNotes ?? []).join(";") || undefined} className="inline-flex items-center gap-0.5 text-[9.5px] font-bold text-red-400/80">
                    <LuBan className="h-2.5 w-2.5" />
                    {th("gateDropChip")}
                  </span>
                ) : c.gate === "review" ? (
                  <span title={(c.gateNotes ?? []).join(";") || undefined} className="inline-flex items-center gap-0.5 text-[9.5px] font-bold text-amber-400">
                    <LuTriangleAlert className="h-2.5 w-2.5" />
                    {th("gateReviewChip")}
                  </span>
                ) : (
                  <span className="text-[9.5px] font-bold text-emerald-400/90">{t("gatePublish")}</span>
                )}
              </span>
            </div>
          );
        })}
        {dropped.length > 0 && (
          <button
            type="button"
            onClick={() => setShowDropped((v) => !v)}
            className="flex h-8 w-full items-center gap-1.5 px-3 text-[11px] text-mut/70 transition-colors hover:text-fg"
          >
            <LuChevronDown className={`h-3 w-3 transition-transform ${showDropped ? "rotate-180" : ""}`} />
            {showDropped ? t("droppedCollapse") : t("droppedRow", { n: dropped.length })}
          </button>
        )}
      </div>
    </div>
  );
}
