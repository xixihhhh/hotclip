import { indexTranscript, searchTranscript } from "../../../../shared/transcript-search";
import { VirtualTranscriptList } from "./VirtualTranscriptList";
import { AlignmentReview } from "./AlignmentReview";
/**
 * 逐句稿页签:工作台里的转写稿视图——逐句纠错(即点即改)+ 热词词表闭环。
 * 与旧 TranscribeView 结果态同一套逻辑,但住进工作台面板,不再是独占一屏。
 */
import { useMemo, useState } from "react";
import { LuBookOpen, LuPencil, LuReplaceAll, LuTriangleAlert, LuX } from "react-icons/lu";
import { useT } from "../../i18n/store";
import { getApi } from "../../api/provider";
import { useSession } from "../../stores/session-store";
import { editSegmentText } from "../../../../shared/edit-transcript";
import { summarizeTimingQuality } from "../../../../shared/transcript-quality";
import { diffReplacement, applyGlossaryToTranscript, countGlossaryHits, upsertGlossaryEntry } from "../../../../shared/glossary";
import { GlossaryModal } from "../GlossaryModal";
import type { GlossaryEntry, Transcript } from "../../../../shared/api-types";

function formatClock(totalSeconds: number): string {
  const s = Math.floor(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const mm = String(m).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function TranscriptPanel({ transcript, onSeek, onAudition }: { transcript: Transcript; onSeek: (sec: number) => void; onAudition: (start: number, end: number) => void }): React.JSX.Element {
  const t = useT("transcribe");
  const { editTranscript } = useSession();
  const [editingSeg, setEditingSeg] = useState<number | null>(null);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [pending, setPending] = useState<{ entry: GlossaryEntry; count: number } | null>(null);
  const [showTimingReview, setShowTimingReview] = useState(false);
  const [query, setQuery] = useState("");
  const [activeHit, setActiveHit] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [alignmentOpen, setAlignmentOpen] = useState(false);
  const timingReviewIds = useMemo(() => new Set(
    transcript.segments
      .filter((segment) => summarizeTimingQuality(segment.words).uncertainWords > 0)
      .map((segment) => segment.id)
  ), [transcript.segments]);
  const searchIndex = useMemo(() => indexTranscript(transcript.segments), [transcript.segments]);
  const hits = useMemo(() => searchTranscript(searchIndex, query).filter((hit) => !showTimingReview || hit.segmentIds.some((id) => timingReviewIds.has(id))), [searchIndex, query, showTimingReview, timingReviewIds]);
  const hit = hits[Math.min(activeHit, Math.max(0, hits.length - 1))];
  const moveHit = (delta: number): void => {
    if (!hits.length) return;
    const next = (activeHit + delta + hits.length) % hits.length;
    setActiveHit(next); onSeek(hits[next].startSec);
  };
  const visibleSegments = useMemo(() => {
    const matched = query.trim() ? new Set(hits.flatMap((h) => h.segmentIds)) : null;
    return transcript.segments.filter((s) => (!showTimingReview || timingReviewIds.has(s.id)) && (!matched || matched.has(s.id)));
  }, [transcript.segments, showTimingReview, timingReviewIds, query, hits]);

  const commitSegEdit = (segId: number, value: string): void => {
    setEditingSeg(null);
    const prevText = transcript.segments.find((s) => s.id === segId)?.text ?? "";
    const next = editSegmentText(transcript, segId, value);
    if (next !== transcript) {
      editTranscript(next);
      // 术语纠错闭环:这次修改若是「错词→对词」,提示一键全片替换+入词表
      const entry = diffReplacement(prevText, value);
      setPending(entry ? { entry, count: countGlossaryHits(next, [entry]) } : null);
    }
  };

  const confirmPending = (): void => {
    if (!pending) return;
    const { transcript: fixed, replaced } = applyGlossaryToTranscript(transcript, [pending.entry]);
    if (replaced > 0) editTranscript(fixed);
    const api = getApi();
    void api
      .glossaryGet()
      .then((list) => api.glossarySet(upsertGlossaryEntry(list, pending.entry)))
      .catch(() => {});
    setPending(null);
  };

  return (
    <div className={`flex flex-1 flex-col overflow-hidden rounded-xl border border-line/60 bg-panel/60 ${alignmentOpen ? "min-h-[520px]" : "min-h-[260px]"}`}>
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line/60 px-3">
        <span className="text-[11px] text-mut">{transcript.engine.startsWith("subtitle-")
          ? t("subtitleResultCount", { n: transcript.segments.length, format: transcript.engine.slice(9).toUpperCase() })
          : t("resultCount", { n: transcript.segments.length, lang: transcript.language })}</span>
        <span className="flex-1" />
        {timingReviewIds.size > 0 && (
          <button
            type="button"
            title={t("timingReviewHint")}
            aria-pressed={showTimingReview}
            onClick={() => setShowTimingReview((value) => !value)}
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-colors ${
              showTimingReview ? "bg-amber-500/10 text-amber-400" : "text-mut hover:text-amber-400"
            }`}
          >
            <LuTriangleAlert className="h-3 w-3" />
            {showTimingReview ? t("timingShowAll") : t("timingReviewOnly", { n: timingReviewIds.size })}
          </button>
        )}
        <button
          type="button"
          onClick={() => setGlossaryOpen(true)}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-mut transition-colors hover:text-fg"
        >
          <LuBookOpen className="h-3 w-3" />
          {t("glossaryBtn")}
        </button>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line/60 px-3 py-2 text-xs">
        <label className="flex min-w-0 flex-1 items-center gap-2">{t("searchLabel")}
          <input type="search" value={query} maxLength={500} onChange={(e) => { setQuery(e.target.value); setActiveHit(0); }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); moveHit(e.shiftKey ? -1 : 1); } }} placeholder={t("searchHint")} className="min-w-0 flex-1 rounded border border-line bg-panel-2 px-2 py-1.5 outline-none focus:border-ember" />
        </label>
        {query.trim() && <>
          <span role="status">{t("searchCount", { current: hits.length ? Math.min(activeHit + 1, hits.length) : 0, n: hits.length === 2000 ? "2000+" : hits.length })}</span>
          <button type="button" disabled={!hits.length} aria-label={t("searchPrevious")} onClick={() => moveHit(-1)} className="rounded border border-line px-2 py-1.5 disabled:opacity-40">↑</button>
          <button type="button" disabled={!hits.length} aria-label={t("searchNext")} onClick={() => moveHit(1)} className="rounded border border-line px-2 py-1.5 disabled:opacity-40">↓</button>
        </>}
        <button type="button" aria-expanded={alignmentOpen} onClick={() => setAlignmentOpen((v) => !v)} className="rounded border border-line px-2 py-1.5">{t("alignToggle")}</button>
      </div>
      {alignmentOpen && <>
        <div className="flex shrink-0 gap-3 px-3 pt-2 text-xs">
          <button type="button" onClick={() => setSelectedIds(new Set(visibleSegments.filter((s) => timingReviewIds.has(s.id)).slice(0, 20).map((s) => s.id)))} className="text-amber-400 underline">{t("alignSelectUncertain")}</button>
          <button type="button" onClick={() => setSelectedIds(new Set())} className="text-mut underline">{t("alignClear")}</button>
        </div>
        <AlignmentReview transcript={transcript} selectedIds={[...selectedIds]} onAudition={onAudition} />
      </>}
      {transcript.engine.startsWith("subtitle-") && (
        <p className="shrink-0 border-b border-line/60 px-3 py-2 text-xs leading-relaxed text-mut">
          {t("subtitleImported")}
        </p>
      )}
      {pending && (
        <div className="mx-2 mt-2 flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-ember/40 bg-ember/5 px-3 py-2">
          <p className="min-w-0 flex-1 text-[11.5px] leading-relaxed">
            {pending.count > 0
              ? t("applyAllMany", { wrong: pending.entry.wrong, right: pending.entry.right, n: pending.count })
              : t("applyAllZero", { wrong: pending.entry.wrong, right: pending.entry.right })}
          </p>
          <button type="button" onClick={confirmPending} className="btn-flame inline-flex items-center gap-1 rounded-lg px-3 py-1 text-[11px] font-bold text-white">
            <LuReplaceAll className="h-3 w-3" />
            {pending.count > 0 ? t("applyAllBtn") : t("applyAllZeroBtn")}
          </button>
          <button
            type="button"
            onClick={() => setPending(null)}
            className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-[11px] text-mut transition-colors hover:text-fg"
          >
            <LuX className="h-3 w-3" />
            {t("applyAllIgnore")}
          </button>
        </div>
      )}
      {visibleSegments.length === 0 && <p className="p-4 text-sm text-mut" role="status">{t("searchEmpty")}</p>}
      <VirtualTranscriptList segments={visibleSegments} targetId={hit?.segmentIds.find((id) => !showTimingReview || timingReviewIds.has(id))} targetKey={`${query}:${activeHit}`} pinnedId={editingSeg} label={t("searchResults")}>
        {(seg) => (
          <div key={seg.id} className={`group/seg flex items-baseline gap-2 rounded-lg px-2.5 py-2 transition-colors hover:bg-panel-2 ${hit?.segmentIds.includes(seg.id) ? "bg-ember/10" : ""}`}>
            {alignmentOpen && <input type="checkbox" aria-label={t("alignSelectSentence", { n: seg.id })} checked={selectedIds.has(seg.id)} onChange={() => setSelectedIds((previous) => { const next = new Set(previous); if (next.has(seg.id)) next.delete(seg.id); else next.add(seg.id); return next; })} />}
            <button
              type="button"
              onClick={() => onSeek(seg.startSec)}
              className="shrink-0 font-mono text-[10.5px] text-ember/80 tabular-nums hover:text-ember"
            >
              {formatClock(seg.startSec)}
            </button>
            {typeof seg.speaker === "number" && (
              <span className="shrink-0 font-mono text-[10px] text-mut/70">S{seg.speaker + 1}</span>
            )}
            {editingSeg === seg.id ? (
              <input
                autoFocus
                defaultValue={seg.text}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setEditingSeg(null);
                }}
                onBlur={(e) => commitSegEdit(seg.id, e.target.value)}
                className="w-full rounded-lg border border-ember/60 bg-panel px-2 py-0.5 text-[13px] leading-relaxed outline-none"
              />
            ) : (
              <p className="flex min-w-0 items-baseline gap-1.5 text-[13px] leading-relaxed">
                <span className="min-w-0 break-words">{(() => { const range = hit?.ranges.find((r) => r.segmentId === seg.id); return range ? <>{seg.text.slice(0, range.start)}<mark className="rounded bg-amber-400/25 text-inherit">{seg.text.slice(range.start, range.end)}</mark>{seg.text.slice(range.end)}</> : seg.text; })()}</span>
                {seg.glossaryApplied && (
                  <span title={t("glossaryFixedHint")} className="chip shrink-0 rounded px-1 py-0.5 text-[9px] text-ember">
                    {t("glossaryFixedBadge")}
                  </span>
                )}
                {timingReviewIds.has(seg.id) && (
                  <span title={t("timingReviewHint")} className="shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1 py-0.5 text-[9px] text-amber-400">
                    {t("timingReviewBadge")}
                  </span>
                )}
                <button
                  type="button"
                  title={t("editSegHint")}
                  onClick={() => setEditingSeg(seg.id)}
                  className="shrink-0 rounded p-0.5 text-mut opacity-0 transition-opacity group-hover/seg:opacity-100 focus:opacity-100 hover:text-fg"
                >
                  <LuPencil className="h-3 w-3" />
                </button>
              </p>
            )}
          </div>
        )}
      </VirtualTranscriptList>
      {glossaryOpen && <GlossaryModal onClose={() => setGlossaryOpen(false)} />}
    </div>
  );
}
