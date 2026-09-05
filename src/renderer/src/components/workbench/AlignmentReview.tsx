import { useEffect, useRef, useState } from "react";
import { getApi } from "../../api/provider";
import { useT } from "../../i18n/store";
import { useSession } from "../../stores/session-store";
import { useAsrStore } from "../../stores/asr-store";
import type { AlignmentPreview, Transcript } from "../../../../shared/api-types";

export function AlignmentReview({ transcript, selectedIds, onAudition }: { transcript: Transcript; selectedIds: number[]; onAudition: (start: number, end: number) => void }): React.JSX.Element {
  const t = useT("transcribe");
  const [engine, setEngine] = useState<"paraformer" | "qwen3">("paraformer");
  const [language, setLanguage] = useState("auto");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<AlignmentPreview | null>(null);
  const [error, setError] = useState("");
  const serial = useRef(0);
  const current = useRef(transcript);
  current.current = transcript;
  const before = useRef(transcript);
  useEffect(() => { setPreview(null); }, [transcript]);
  useEffect(() => () => { serial.current++; getApi().cancelAlignment(); }, []);
  const run = async (): Promise<void> => {
    const file = useSession.getState().file;
    if (!file) return;
    const id = ++serial.current;
    before.current = transcript;
    setBusy(true); setError(""); setPreview(null);
    try {
      const result = await getApi().previewAlignment(file.path, transcript, { segmentIds: selectedIds, engine, language: language === "auto" ? transcript.language : language, localServiceUrl: useAsrStore.getState().localServiceUrl });
      if (id === serial.current && current.current === before.current) setPreview(result);
    } catch (error) {
      if (id === serial.current) setError(String(error).includes("cancelled") ? t("speechCancelled") : `${t("alignFailed")} ${String(error).replace(/^Error: /, "")}`);
    } finally { if (id === serial.current) setBusy(false); }
  };
  return <div className="shrink-0 space-y-2 border-b border-line/60 px-3 py-2 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      <label>{t("alignEngine")} <select aria-label={t("alignEngine")} value={engine} disabled={busy} onChange={(e) => setEngine(e.target.value as typeof engine)} className="rounded border border-line bg-panel-2 p-1.5">
        <option value="paraformer">Paraformer · 中文 / English</option><option value="qwen3">Qwen3 · {t("localServiceName")}</option>
      </select></label>
      <label>{t("alignLanguage")} <select aria-label={t("alignLanguage")} value={language} disabled={busy} onChange={(e) => setLanguage(e.target.value)} className="rounded border border-line bg-panel-2 p-1.5">
        <option value="auto">{t("alignLanguageAuto")}</option>
        {["zh", "en", "yue", "fr", "de", "it", "ja", "ko", "pt", "ru", "es"].map((lang) => <option key={lang}>{lang}</option>)}
      </select></label>
      <button type="button" disabled={busy || !selectedIds.length} onClick={() => void run()} className="rounded border border-ember/40 px-2.5 py-1.5 text-ember disabled:opacity-40">{busy ? t("alignRunning") : t("alignSelected", { n: selectedIds.length })}</button>
      {busy && <button type="button" onClick={() => getApi().cancelAlignment()} className="rounded border border-line px-2 py-1.5">{t("alignCancel")}</button>}
    </div>
    <p className="text-mut">{t("alignHint")}</p>
    {error && <p role="alert" className="break-words text-red-400">{error}</p>}
    {preview && <div className="space-y-2 rounded-lg border border-line bg-panel-2 p-2">
      <p role="status">{t("alignSummary", { n: preview.segments.length, words: preview.alignedWords, uncertain: preview.uncertainWords, skipped: preview.skipped.length })}</p>
      <div className="max-h-28 space-y-1 overflow-y-auto">
        {preview.segments.map((seg) => <div key={seg.id} className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{seg.text}</span>
          <button type="button" className="text-mut underline" onClick={() => { const old = before.current.segments.find((s) => s.id === seg.id)!.words; onAudition(old[0].startSec, old[old.length - 1].endSec); }}>{t("alignBefore")}</button>
          <button type="button" className="text-ember underline" onClick={() => onAudition(seg.words[0].startSec, seg.words[seg.words.length - 1].endSec)}>{t("alignAfter")}</button>
        </div>)}
        {preview.skipped.length > 0 && <p className="text-amber-400">{t("alignSkippedHint")}</p>}
      </div>
      <div className="flex gap-2">
        <button type="button" disabled={!preview.segments.length} className="btn-flame rounded px-3 py-1.5 text-white disabled:opacity-40" onClick={() => {
          if (current.current !== before.current) return;
          const updated = new Map(preview.segments.map((s) => [s.id, s]));
          useSession.getState().editTranscript({ ...transcript, segments: transcript.segments.map((s) => updated.get(s.id) ?? s) });
          setPreview(null);
        }}>{t("alignApply")}</button>
        <button type="button" onClick={() => setPreview(null)} className="rounded border border-line px-3 py-1.5">{t("alignDiscard")}</button>
      </div>
    </div>}
  </div>;
}
