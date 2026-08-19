/**
 * 右栏 Inspector:上下文面板,两个页签——
 *  - 候选详情:选中候选的四维分/钩子/理由/边界微调/审阅台入口
 *  - 检测参数:品类/时长档/商品词/点题/多人对谈/参考爆款,改动只标脏,
 *    「重新检测」按钮是唯一会重跑 AI 的东西(废除静默重跑)
 */
import { useState } from "react";
import {
  LuChevronLeft,
  LuChevronRight,
  LuPencil,
  LuPlay,
  LuQuote,
  LuScissorsLineDashed,
  LuSparkles,
  LuTarget,
  LuTriangleAlert,
  LuShoppingCart,
  LuRefreshCw,
} from "react-icons/lu";
import { useT, useLocaleStore } from "../../i18n/store";
import { getApi } from "../../api/provider";
import { useSession } from "../../stores/session-store";
import { useRenderPrefs } from "../../stores/render-prefs-store";
import { GENRE_PRESETS, GENRE_CUSTOM_MAX_CHARS } from "../../../../core/genre";
import { adjustCandidateBoundary } from "../../../../shared/boundary";
import { clipDurationSec, isStitched } from "../../../../shared/pieces";
import { SectionLabel, Segmented, SwitchRow } from "../ui";
import type { ClipLength, HighlightCandidate, Transcript } from "../../../../shared/api-types";

function formatClock(totalSeconds: number): string {
  const s = Math.floor(totalSeconds);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const BOUNDARY_KEY = {
  exact: "boundaryExact",
  anchored: "boundaryAnchored",
  segment: "boundarySegment",
  signal: "boundarySignal",
} as const;

/** 候选详情页签。 */
function DetailTab({
  c,
  transcript,
  rank,
  total,
  onOpenReview,
}: {
  c: HighlightCandidate;
  transcript: Transcript;
  rank: number;
  total: number;
  onOpenReview: (id: number) => void;
}): React.JSX.Element {
  const t = useT("workbench");
  const th = useT("highlights");
  const { patchCandidate } = useSession();
  const [editingTitle, setEditingTitle] = useState(false);

  const nudge = (edge: "start" | "end", dir: 1 | -1): void => {
    const adjusted = adjustCandidateBoundary(transcript, c, edge, dir);
    if (adjusted) patchCandidate(c.id, { ...adjusted, boundary: "segment", manualBounds: true });
  };

  return (
    <div className="flex flex-col gap-4">
      {/* 分数 + 档位 */}
      <div className="flex items-baseline gap-2.5">
        {c.score > 0 ? (
          <>
            <span className="flame-text font-mono text-[26px] font-extrabold tabular-nums">{c.score}</span>
            <span className="text-[10.5px] text-mut">
              {t("rankLabel")} · {rank}/{total}
            </span>
          </>
        ) : (
          <span className="chip rounded-full px-3 py-1 text-[11px] font-bold text-mut">{th("manualChip")}</span>
        )}
        <span className="flex-1" />
        {c.gate === "review" ? (
          <span className="rounded-full border border-amber-500/40 px-2.5 py-0.5 text-[10px] font-bold text-amber-400">{th("gateReviewChip")}</span>
        ) : c.gate === "drop" ? (
          <span className="rounded-full border border-red-400/40 px-2.5 py-0.5 text-[10px] font-bold text-red-400">{th("gateDropChip")}</span>
        ) : (
          <span className="rounded-full border border-emerald-400/40 px-2.5 py-0.5 text-[10px] font-bold text-emerald-400">{t("gatePublish")}</span>
        )}
      </div>

      {/* 标题(即点即改) */}
      <div className="flex flex-col gap-1.5">
        <SectionLabel>{t("fieldTitle")}</SectionLabel>
        {editingTitle ? (
          <input
            autoFocus
            defaultValue={c.title}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setEditingTitle(false);
            }}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v) patchCandidate(c.id, { title: v });
              setEditingTitle(false);
            }}
            className="w-full rounded-lg border border-ember/60 bg-panel-2 px-2.5 py-2 text-[13px] font-bold outline-none"
          />
        ) : (
          <button
            type="button"
            title={th("editTitleHint")}
            onClick={() => setEditingTitle(true)}
            className="group flex items-start gap-1.5 rounded-lg border border-line bg-panel-2 px-2.5 py-2 text-left text-[13px] leading-snug font-bold transition-colors hover:border-mut"
          >
            <span className="min-w-0 flex-1">{c.title}</span>
            <LuPencil className="mt-0.5 h-3 w-3 shrink-0 text-mut opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        )}
      </div>

      {/* 钩子 + 理由 */}
      {(c.hook || c.reason || c.teaser) && (
        <div className="flex flex-col gap-1.5">
          <SectionLabel>{t("fieldHook")}</SectionLabel>
          {c.hook && (
            <p className="flex items-start gap-1.5 border-l-2 border-flame/80 pl-2.5 text-[12px] leading-relaxed text-fg/90">
              <LuQuote className="mt-0.5 h-3 w-3 shrink-0 text-ember" />
              {c.hook}
            </p>
          )}
          {c.reason && (
            <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-mut">
              <LuSparkles className="mt-0.5 h-3 w-3 shrink-0 text-ember/70" />
              {c.reason}
            </p>
          )}
          {c.teaser && (
            <p className="text-[11px] leading-relaxed text-fg/60">
              <span className="mr-1.5 rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-mut">{th("teaserLabel")}</span>
              {c.teaser}
            </p>
          )}
        </div>
      )}

      {/* 四维评审 */}
      {c.scoreDims && (
        <div className="flex flex-col gap-1.5">
          <SectionLabel>{t("fieldDims")}</SectionLabel>
          {(
            [
              ["dimHook", c.scoreDims.hook, c.dimNotes?.hook],
              ["dimFlow", c.scoreDims.flow, c.dimNotes?.flow],
              ["dimValue", c.scoreDims.value, c.dimNotes?.value],
              ["dimTrend", c.scoreDims.trend, c.dimNotes?.trend],
            ] as const
          ).map(([key, val, note]) => (
            <div key={key} className="flex items-center gap-2" title={note || undefined}>
              <span className="w-7 shrink-0 text-[10.5px] text-mut">{th(key)}</span>
              <span className="relative h-[5px] min-w-0 flex-1 overflow-hidden rounded-full bg-line/70">
                <span className="flame-gradient absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(100, Math.max(0, val))}%` }} />
              </span>
              <span className="w-5 shrink-0 text-right font-mono text-[10.5px] tabular-nums">{val}</span>
            </div>
          ))}
        </div>
      )}

      {/* 质量门/复评备注 */}
      {(!c.recommended || (c.gateNotes?.length ?? 0) > 0) && (
        <p
          className={`flex items-start gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed ${
            c.gate === "drop" ? "bg-red-500/10 text-red-400/90" : "bg-amber-500/10 text-amber-400"
          }`}
        >
          <LuTriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            {c.gate === "drop" ? th("gateDropNote") : c.gate === "review" ? th("gateReviewNote") : th("reviewWeak")}
            {c.gateNotes?.length ? `:${c.gateNotes.join(";")}` : c.reviewNote ? `:${c.reviewNote}` : ""}
          </span>
        </p>
      )}

      {/* 边界微调 */}
      <div className="flex flex-col gap-1.5">
        <SectionLabel>
          {t("fieldBoundary")} · {th(BOUNDARY_KEY[c.boundary])}
        </SectionLabel>
        <div className="flex items-center gap-1.5">
          <div className="flex min-w-0 flex-1 items-center justify-between rounded-lg border border-line bg-panel-2 px-1.5 py-1">
            <button type="button" title={th("nudgeStartBack")} onClick={() => nudge("start", -1)} className="rounded p-0.5 text-mut hover:text-fg">
              <LuChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="font-mono text-[10.5px] tabular-nums">{formatClock(c.startSec)}</span>
            <button type="button" title={th("nudgeStartFwd")} onClick={() => nudge("start", 1)} className="rounded p-0.5 text-mut hover:text-fg">
              <LuChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
          <span className="shrink-0 font-mono text-[10px] text-mut/70 tabular-nums">{Math.round(clipDurationSec(c))}s</span>
          <div className="flex min-w-0 flex-1 items-center justify-between rounded-lg border border-line bg-panel-2 px-1.5 py-1">
            <button type="button" title={th("nudgeEndBack")} onClick={() => nudge("end", -1)} className="rounded p-0.5 text-mut hover:text-fg">
              <LuChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="font-mono text-[10.5px] tabular-nums">{formatClock(c.endSec)}</span>
            <button type="button" title={th("nudgeEndFwd")} onClick={() => nudge("end", 1)} className="rounded p-0.5 text-mut hover:text-fg">
              <LuChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        {isStitched(c.pieces) && (
          <p className="flex items-start gap-1.5 text-[10.5px] leading-relaxed text-ember/90" title={th("stitchedHint")}>
            <LuScissorsLineDashed className="mt-0.5 h-3 w-3 shrink-0" />
            {th("stitchedChip", { n: c.pieces!.length })}
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={() => onOpenReview(c.id)}
        className="flex h-8.5 items-center justify-center gap-1.5 rounded-lg border border-ember/50 text-[12px] font-bold text-ember transition-colors hover:bg-ember/10"
      >
        <LuPlay className="h-3.5 w-3.5" />
        {th("reviewOpen")}
      </button>
    </div>
  );
}

/** 检测参数页签:改动标脏,「重新检测」显式生效。 */
function ParamsTab({ onRedetect }: { onRedetect: () => void }): React.JSX.Element {
  const t = useT("workbench");
  const th = useT("highlights");
  const lang = useLocaleStore((s) => s.locale);
  const { prefs, setPref } = useRenderPrefs();
  const { diarize, setDiarize, referencePath, setReferencePath, paramsDirty, markParamsDirty, detecting } = useSession();

  const dirty = (): void => markParamsDirty(true);

  const toggleReference = async (): Promise<void> => {
    if (referencePath) {
      setReferencePath(null);
      dirty();
      return;
    }
    const p = await getApi().selectMedia();
    if (!p) return;
    setReferencePath(p);
    dirty();
  };

  return (
    <div className="flex flex-col gap-3.5">
      <p className="text-[10.5px] leading-relaxed text-mut/70">{t("paramsHint")}</p>

      <div className="flex flex-col gap-1.5">
        <SectionLabel>{t("paramGenre")}</SectionLabel>
        <select
          value={prefs.genreId}
          title={th("genreHint")}
          onChange={(e) => {
            setPref({ genreId: e.target.value });
            dirty();
          }}
          className="w-full rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-[12px] outline-none focus:border-ember/60"
        >
          {GENRE_PRESETS.map((g) => (
            <option key={g.id} value={g.id}>
              {lang === "zh" ? g.labelZh : g.labelEn}
            </option>
          ))}
        </select>
        {(prefs.genreId === "custom" || prefs.genreCustom.trim()) && (
          <input
            defaultValue={prefs.genreCustom}
            placeholder={th("genrePlaceholder")}
            title={th("genreCustomHint")}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            onBlur={(e) => {
              const v = e.target.value.slice(0, GENRE_CUSTOM_MAX_CHARS);
              if (v !== prefs.genreCustom) {
                setPref({ genreCustom: v });
                dirty();
              }
            }}
            className="w-full rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-[11.5px] outline-none focus:border-ember/60"
          />
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <SectionLabel>{t("paramLength")}</SectionLabel>
        <Segmented<ClipLength>
          value={prefs.clipLength}
          options={[
            { value: "short", label: t("lengthShortSeg"), title: th("lengthHint") },
            { value: "standard", label: t("lengthStandardSeg") },
            { value: "long", label: t("lengthLongSeg") },
          ]}
          onChange={(v) => {
            setPref({ clipLength: v });
            dirty();
          }}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <SectionLabel>{t("paramProducts")}</SectionLabel>
        <input
          defaultValue={prefs.products.join(",")}
          placeholder={th("productsPlaceholder")}
          title={th("productsHint")}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          onBlur={(e) => {
            const next = [...new Set(e.target.value.split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean))].slice(0, 20);
            if (JSON.stringify(next) !== JSON.stringify(prefs.products)) {
              setPref({ products: next });
              dirty();
            }
          }}
          className="w-full rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-[11.5px] outline-none focus:border-ember/60"
        />
        {prefs.products.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {prefs.products.map((p) => (
              <span key={p} className="chip inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-ember">
                <LuShoppingCart className="h-2.5 w-2.5" />
                {p}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <SectionLabel>{t("paramBrief")}</SectionLabel>
        <input
          defaultValue={prefs.briefFocus}
          placeholder={th("briefFocusPlaceholder")}
          title={th("briefHint")}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          onBlur={(e) => {
            const v = e.target.value.trim().slice(0, 300);
            if (v !== prefs.briefFocus) {
              setPref({ briefFocus: v });
              dirty();
            }
          }}
          className="w-full rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-[11.5px] outline-none focus:border-ember/60"
        />
        <input
          defaultValue={prefs.briefExclude}
          placeholder={th("briefExcludePlaceholder")}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          onBlur={(e) => {
            const v = e.target.value.trim().slice(0, 300);
            if (v !== prefs.briefExclude) {
              setPref({ briefExclude: v });
              dirty();
            }
          }}
          className="w-full rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-[11.5px] outline-none focus:border-ember/60"
        />
      </div>

      <SwitchRow
        label={t("paramDiarize")}
        hint={th("optDiarizeHint")}
        on={diarize}
        onToggle={() => {
          setDiarize(!diarize);
          dirty();
        }}
      />

      <div className="flex items-center justify-between gap-2">
        <SectionLabel>{t("paramReference")}</SectionLabel>
        <button
          type="button"
          title={referencePath ? th("refHintOn", { name: referencePath.split(/[\\/]/).pop() ?? "" }) : th("refHint")}
          onClick={() => void toggleReference()}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
            referencePath ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut hover:text-fg"
          }`}
        >
          <LuTarget className={`h-3 w-3 ${referencePath ? "text-ember" : ""}`} />
          {referencePath ? (referencePath.split(/[\\/]/).pop() ?? "").slice(0, 14) : th("refButton")}
        </button>
      </div>

      {paramsDirty && <p className="rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-400">{t("redetectDirty")}</p>}
      <button
        type="button"
        disabled={detecting}
        onClick={onRedetect}
        className={`flex h-8.5 items-center justify-center gap-1.5 rounded-lg text-[12.5px] font-bold transition-colors disabled:opacity-40 ${
          paramsDirty ? "btn-flame text-white" : "border border-line text-mut hover:border-mut hover:text-fg"
        }`}
      >
        <LuRefreshCw className={`h-3.5 w-3.5 ${detecting ? "animate-spin" : ""}`} />
        {t("redetect")}
      </button>
    </div>
  );
}

export function Inspector({
  transcript,
  onRedetect,
  onOpenReview,
}: {
  transcript: Transcript;
  onRedetect: () => void;
  onOpenReview: (id: number) => void;
}): React.JSX.Element {
  const t = useT("workbench");
  const { candidates, focusedId, paramsDirty } = useSession();
  const [tab, setTab] = useState<"detail" | "params">("detail");
  const focused = candidates?.find((c) => c.id === focusedId) ?? null;
  // 同批排名:按分数从高到低,聚焦候选排第几(手动 0 分不参与)
  const scored = (candidates ?? []).filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
  const rank = focused ? scored.findIndex((c) => c.id === focused.id) + 1 : 0;

  return (
    <div className="flex w-[300px] shrink-0 flex-col border-l border-line/70 bg-panel/40">
      <div className="flex shrink-0 border-b border-line/60">
        {(
          [
            ["detail", t("tabDetail")],
            ["params", t("tabParams")],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`relative flex-1 py-2.5 text-[11.5px] font-bold transition-colors ${tab === key ? "text-fg" : "text-mut hover:text-fg/80"}`}
          >
            {label}
            {key === "params" && paramsDirty && <span className="absolute top-2 ml-1 h-1.5 w-1.5 rounded-full bg-amber-400" />}
            {tab === key && <span className="flame-gradient absolute inset-x-6 bottom-0 h-0.5 rounded-full" />}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
        {tab === "params" ? (
          <ParamsTab onRedetect={onRedetect} />
        ) : focused ? (
          <DetailTab c={focused} transcript={transcript} rank={rank} total={scored.length} onOpenReview={onOpenReview} />
        ) : (
          <p className="mt-8 text-center text-[11.5px] leading-relaxed text-mut/70">{t("inspectorEmpty")}</p>
        )}
      </div>
    </div>
  );
}
