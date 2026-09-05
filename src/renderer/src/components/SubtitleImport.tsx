import { useEffect, useRef, useState } from "react";
import { LuFileUp } from "react-icons/lu";
import type { Transcript } from "../../../shared/api-types";
import { SUBTITLE_IMPORT_MAX_BYTES, subtitleImportError } from "../../../shared/subtitle-import";
import { getApi } from "../api/provider";
import { useT } from "../i18n/store";

export function SubtitleImport({ filePath, onImported, onBusy }: {
  filePath: string;
  onImported: (transcript: Transcript) => void;
  onBusy: (busy: boolean) => void;
}): React.JSX.Element {
  const t = useT("transcribe");
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    return () => { generation.current++; };
  }, [filePath]);

  const load = async (file: File): Promise<void> => {
    const request = ++generation.current;
    setError(null);
    setBusy(true);
    onBusy(true);
    try {
      const format = file.name.split(".").pop()?.toLowerCase();
      if (format !== "srt" && format !== "vtt") throw new Error("subtitle-import:format:0");
      if (file.size > SUBTITLE_IMPORT_MAX_BYTES) throw new Error("subtitle-import:size:0");
      const text = await file.text();
      if (request !== generation.current) return;
      const transcript = await getApi().importSubtitle(filePath, text, format);
      if (request === generation.current) onImported(transcript);
    } catch (e) {
      if (request !== generation.current) return;
      const issue = subtitleImportError(e);
      setError(issue ? `${t(`subtitleError_${issue.code}`)}${issue.cue ? ` ${t("subtitleErrorCue", { n: issue.cue })}` : ""}` : t("subtitleFailed"));
    } finally {
      if (request === generation.current) {
        setBusy(false);
        onBusy(false);
      }
    }
  };

  return (
    <div className="mt-5 w-full rounded-xl border border-line bg-panel/60 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <p className="text-sm font-semibold">{t("subtitleTitle")}</p>
          <p className="mt-1 text-xs leading-relaxed text-mut">{t("subtitleHint")}</p>
        </div>
        <input
          ref={input}
          type="file"
          accept=".srt,.vtt"
          aria-label={t("subtitleImport")}
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void load(file);
          }}
        />
        <button
          type="button"
          disabled={busy}
          aria-busy={busy}
          onClick={() => input.current?.click()}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-line px-4 py-2 text-sm font-semibold text-fg transition-colors hover:border-ember/60 hover:bg-ember/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ember disabled:opacity-50"
        >
          <LuFileUp className="h-4 w-4 shrink-0" aria-hidden="true" />
          {busy ? t("subtitleImporting") : t("subtitleImport")}
        </button>
      </div>
      {error && <p role="alert" className="mt-3 text-xs leading-relaxed text-red-400">{error}</p>}
    </div>
  );
}
