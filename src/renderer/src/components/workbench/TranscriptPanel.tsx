/**
 * 逐句稿页签:工作台里的转写稿视图——逐句纠错(即点即改)+ 热词词表闭环。
 * 与旧 TranscribeView 结果态同一套逻辑,但住进工作台面板,不再是独占一屏。
 */
import { useState } from "react";
import { LuBookOpen, LuPencil, LuReplaceAll, LuX } from "react-icons/lu";
import { useT } from "../../i18n/store";
import { getApi } from "../../api/provider";
import { useSession } from "../../stores/session-store";
import { editSegmentText } from "../../../../shared/edit-transcript";
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

export function TranscriptPanel({ transcript, onSeek }: { transcript: Transcript; onSeek: (sec: number) => void }): React.JSX.Element {
  const t = useT("transcribe");
  const { editTranscript } = useSession();
  const [editingSeg, setEditingSeg] = useState<number | null>(null);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [pending, setPending] = useState<{ entry: GlossaryEntry; count: number } | null>(null);

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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line/60 bg-panel/60">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line/60 px-3">
        <span className="text-[11px] text-mut">{t("resultCount", { n: transcript.segments.length, lang: transcript.language })}</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setGlossaryOpen(true)}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-mut transition-colors hover:text-fg"
        >
          <LuBookOpen className="h-3 w-3" />
          {t("glossaryBtn")}
        </button>
      </div>
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
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {transcript.segments.map((seg) => (
          <div key={seg.id} className="group/seg flex items-baseline gap-3 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-panel-2">
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
                <span className="min-w-0">{seg.text}</span>
                {seg.glossaryApplied && (
                  <span title={t("glossaryFixedHint")} className="chip shrink-0 rounded px-1 py-0.5 text-[9px] text-ember">
                    {t("glossaryFixedBadge")}
                  </span>
                )}
                <button
                  type="button"
                  title={t("editSegHint")}
                  onClick={() => setEditingSeg(seg.id)}
                  className="shrink-0 rounded p-0.5 text-mut opacity-0 transition-opacity group-hover/seg:opacity-100 hover:text-fg"
                >
                  <LuPencil className="h-3 w-3" />
                </button>
              </p>
            )}
          </div>
        ))}
      </div>
      {glossaryOpen && <GlossaryModal onClose={() => setGlossaryOpen(false)} />}
    </div>
  );
}
