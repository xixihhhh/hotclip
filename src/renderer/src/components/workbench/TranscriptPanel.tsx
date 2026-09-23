import { canSearchSimilarTranscript, indexTranscript, searchSimilarTranscript, searchTranscript } from "../../../../shared/transcript-search";
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
import { searchVisualEvidence, type VisualEvidenceNote } from "../../../../shared/evidence-search";
import { evidenceContext, evidenceResults, nextEvidenceIndex, type EvidenceSource } from "../../../../shared/evidence-navigation";
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

export function TranscriptPanel({ transcript, visualNotes, onSeek, onAudition, onPick }: { transcript: Transcript; visualNotes?: readonly VisualEvidenceNote[]; onSeek: (sec: number) => void; onAudition: (start: number, end: number) => void; onPick: (segmentIds: number[]) => void }): React.JSX.Element {
  const t = useT("transcribe");
  const { editTranscript } = useSession();
  const [editingSeg, setEditingSeg] = useState<number | null>(null);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [pending, setPending] = useState<{ entry: GlossaryEntry; count: number } | null>(null);
  const [showTimingReview, setShowTimingReview] = useState(false);
  const [query, setQuery] = useState("");
  const [similarMode, setSimilarMode] = useState(false);
  const [activeHit, setActiveHit] = useState(-1);
  const [source, setSource] = useState<EvidenceSource>("all");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [alignmentOpen, setAlignmentOpen] = useState(false);
  const timingReviewIds = useMemo(() => new Set(
    transcript.segments
      .filter((segment) => summarizeTimingQuality(segment.words).uncertainWords > 0)
      .map((segment) => segment.id)
  ), [transcript.segments]);
  const searchIndex = useMemo(() => indexTranscript(transcript.segments), [transcript.segments]);
  const exactHits = useMemo(() => searchTranscript(searchIndex, query).filter((hit) => !showTimingReview || hit.segmentIds.some((id) => timingReviewIds.has(id))), [searchIndex, query, showTimingReview, timingReviewIds]);
  const hits = useMemo(() => similarMode && exactHits.length === 0
    ? searchSimilarTranscript(searchIndex, query).filter((hit) => !showTimingReview || hit.segmentIds.some((id) => timingReviewIds.has(id)))
    : exactHits, [similarMode, exactHits, searchIndex, query, showTimingReview, timingReviewIds]);
  const visualHits = useMemo(() => searchVisualEvidence(visualNotes, query), [visualNotes, query]);
  const results = useMemo(() => evidenceResults(hits, visualHits, transcript.durationSec, source), [hits, visualHits, transcript.durationSec, source]);
  const result = results[Math.max(0, Math.min(activeHit, results.length - 1))];
  const hit = result?.kind === "transcript" ? result.hit : undefined;
  const context = useMemo(() => result ? evidenceContext(result, transcript.segments, transcript.durationSec) : null, [result, transcript]);
  const moveHit = (delta: 1 | -1): void => {
    const next = nextEvidenceIndex(activeHit, results.length, delta);
    if (next < 0) return;
    setActiveHit(next); onSeek(results[next].startSec);
  };
  const visibleSegments = useMemo(() => {
    const matched = query.trim() ? new Set(results.flatMap((r) => r.kind === "transcript" ? r.hit.segmentIds : [])) : null;
    return transcript.segments.filter((s) => (!showTimingReview || timingReviewIds.has(s.id)) && (!matched || matched.has(s.id)));
  }, [transcript.segments, showTimingReview, timingReviewIds, query, results]);

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
            onClick={() => { setShowTimingReview((value) => !value); setSimilarMode(false); setActiveHit(-1); }}
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
          <input type="search" value={query} maxLength={500} onChange={(e) => { setQuery(e.target.value); setSimilarMode(false); setActiveHit(-1); }} onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); moveHit(e.shiftKey ? -1 : 1); } }} placeholder={t("searchHint")} className="min-w-0 flex-1 rounded border border-line bg-panel-2 px-2 py-1.5 outline-none focus:border-ember" />
        </label>
        {query.trim() && <>
          <span role="status">{t("searchCount", { current: results.length ? Math.max(1, Math.min(activeHit + 1, results.length)) : 0, n: `${results.length}${(source !== "visual" && hits.length === (similarMode ? 200 : 2000)) || (source !== "transcript" && visualHits.length === 200) ? "+" : ""}` })}</span>
          <button type="button" disabled={!results.length} aria-label={t("searchPrevious")} onClick={() => moveHit(-1)} className="rounded border border-line px-2 py-1.5 disabled:opacity-40">↑</button>
          <button type="button" disabled={!results.length} aria-label={t("searchNext")} onClick={() => moveHit(1)} className="rounded border border-line px-2 py-1.5 disabled:opacity-40">↓</button>
        </>}
        <button type="button" aria-expanded={alignmentOpen} onClick={() => setAlignmentOpen((v) => !v)} className="rounded border border-line px-2 py-1.5">{t("alignToggle")}</button>
      </div>
      {query.trim() && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line/60 px-3 py-2 text-xs" role="group" aria-label={t("searchSource")}>
        {(["all", "transcript", "visual"] as const).map((value) => <button type="button" key={value} aria-pressed={source === value} onClick={() => { setSource(value); setSimilarMode(false); setActiveHit(-1); }} className={`rounded-md border px-2 py-1 transition-colors ${source === value ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:text-fg"}`}>{t(`searchSource_${value}`)}</button>)}
        {source !== "visual" && exactHits.length === 0 && canSearchSimilarTranscript(query) && (
          <button type="button" aria-pressed={similarMode} title={t("searchSimilarHint")} onClick={() => { setSimilarMode((value) => !value); setActiveHit(-1); }} className={`rounded-md border px-2 py-1 transition-colors ${similarMode ? "border-amber-400/60 bg-amber-400/10 text-amber-300" : "border-line text-mut hover:text-fg"}`}>{t("searchSimilar")}</button>
        )}
        <span className="text-mut">{t("searchKeyboardHint")}</span>
      </div>}
      {result && context && <div className="shrink-0 border-b border-line/60 bg-panel-2/40 px-3 py-2 text-xs" aria-label={t("searchCurrent")}>
        <div className="flex flex-wrap items-center gap-2 text-mut">
          <span>{t(result.kind === "visual" ? "visualSearchLabel" : "searchSource_transcript")}</span>
          <span className="font-mono text-ember">{formatClock(result.startSec)}</span>
          {result.kind === "transcript" && <span>{t(`searchTiming_${result.hit.timing}`)}</span>}
          {result.kind === "transcript" && result.hit.match === "approximate" && <span className="text-amber-300">{t("searchSimilarBadge")}</span>}
        </div>
        <p className="mt-1 line-clamp-2 break-words leading-relaxed">{result.kind === "visual"
          ? result.hit.match === "screen-text" ? result.hit.visibleText?.join(" / ") : result.hit.note
          : result.hit.ranges.map((range) => transcript.segments.find((s) => s.id === range.segmentId)?.text.slice(range.start, range.end) ?? "").join(" … ")}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => onSeek(result.startSec)} className="rounded-md border border-line px-2.5 py-1.5 hover:border-mut">{t("searchLocate")}</button>
          <button type="button" onClick={() => onAudition(context.startSec, context.endSec)} className="rounded-md border border-line px-2.5 py-1.5 hover:border-mut">{t("searchAudition")}</button>
          <button type="button" disabled={!context.segmentIds.length} onClick={() => onPick(context.segmentIds)} className="rounded-md border border-ember/50 bg-ember/10 px-2.5 py-1.5 text-ember hover:border-ember disabled:opacity-40">{t("searchPick")}</button>
          <span className="text-mut">{t(context.segmentIds.length ? "searchPickHint" : "searchNoNearbySpeech")}</span>
        </div>
      </div>}
      {query.trim() && source !== "transcript" && visualHits.length > 0 && (
        <div className="shrink-0 border-b border-line/60 px-3 py-2" aria-label={t("visualSearchLabel")}>
          <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-sky-400/80">{t("visualSearchLabel")}</p>
          <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
            {results.flatMap((r, index) => r.kind === "visual" ? [{ item: r.hit, index, id: r.id }] : []).map(({ item, index, id }) => (
              <button
                type="button"
                key={item.id}
                aria-pressed={result?.id === id}
                onClick={() => { setActiveHit(index); onSeek(item.t); }}
                title={item.visibleText?.length ? item.visibleText.join(" / ") : item.note}
                className={`max-w-full truncate rounded-md border px-2 py-1 text-left text-[11px] text-sky-200 transition-colors hover:border-sky-300/60 hover:bg-sky-400/10 ${result?.id === id ? "border-sky-300/60 bg-sky-400/15" : "border-sky-400/25 bg-sky-400/5"}`}
              >
                <span className="mr-1 font-mono text-[10px] text-sky-300/80">{formatClock(item.t)}</span>
                {item.match === "screen-text" ? item.visibleText?.join(" / ") : item.note}
              </button>
            ))}
          </div>
        </div>
      )}
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
      {visibleSegments.length === 0 && results.length === 0 && <p className="p-4 text-sm text-mut" role="status">{similarMode ? t("searchSimilarEmpty") : t("searchEmpty")}</p>}
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
