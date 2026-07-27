/**
 * 录播监听控制面板:选一个文件夹开始盯,新录播写完落稳后自动全托管切片
 * (转写→找爆点→出片),事件流实时滚动——直播录完即切,7×24 无人值守。
 */
import { useEffect, useRef, useState } from "react";
import { LuFolderSearch, LuX, LuPlay, LuSquare, LuCircleCheck, LuCircleAlert, LuLoaderCircle, LuFileVideo } from "react-icons/lu";
import { useT } from "../i18n/store";
import { getApi, isElectron } from "../api/provider";
import { useLlmStore, isLlmReady } from "../stores/llm-store";
import { useRenderPrefs } from "../stores/render-prefs-store";
import type { WatchEvent } from "../../../shared/api-types";

function fmtTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function WatchFolderModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const t = useT("watch");
  const { config } = useLlmStore();
  const llmOk = !isElectron() || isLlmReady(config);
  const [dir, setDir] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<WatchEvent[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const api = getApi();
    void api.watchStatus().then((s) => {
      setRunning(s.running);
      if (s.dir) setDir(s.dir);
    });
    return api.onWatchEvent((e) => {
      setEvents((prev) => [...prev.slice(-199), e]);
    });
  }, []);

  // 新事件进来自动滚到底
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [events]);

  const pickDir = async (): Promise<void> => {
    const picked = await getApi().selectDir();
    if (picked) setDir(picked);
  };

  const toggle = async (): Promise<void> => {
    const api = getApi();
    if (running) {
      await api.watchStop();
      setRunning(false);
      return;
    }
    if (!dir) return;
    // 用户自选过导出位置的话,无人值守的成片也落那儿(与向导出片一处设置)
    await api.watchStart(dir, config, useRenderPrefs.getState().prefs.outDir || undefined);
    setRunning(true);
  };

  const EVENT_META: Record<WatchEvent["type"], { label: string; cls: string; spin?: boolean }> = {
    found: { label: t("evFound"), cls: "text-sky-400" },
    transcribing: { label: t("evTranscribing"), cls: "text-amber-300", spin: true },
    detecting: { label: t("evDetecting"), cls: "text-amber-300", spin: true },
    exporting: { label: t("evExporting"), cls: "text-amber-300", spin: true },
    done: { label: t("evDone"), cls: "text-emerald-400" },
    error: { label: t("evError"), cls: "text-red-400" },
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      onClick={onClose}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      role="presentation"
    >
      <section
        className="card w-full max-w-xl rounded-2xl p-6"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t("title")}
      >
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-extrabold">
            <LuFolderSearch className="h-5 w-5 text-ember" />
            {t("title")}
            {running && <span className="ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400" />}
          </h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-mut transition-colors hover:text-fg" aria-label="close">
            <LuX className="h-4.5 w-4.5" />
          </button>
        </div>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-mut">{t("desc")}</p>

        <div className="mt-4 flex items-center gap-2.5">
          <button
            type="button"
            onClick={pickDir}
            disabled={running}
            className="min-w-0 flex-1 truncate rounded-lg border border-line bg-panel-2 px-3 py-2 text-left text-[13px] text-mut transition-colors hover:border-mut hover:text-fg disabled:opacity-50"
          >
            {dir ?? t("pickDir")}
          </button>
          <button
            type="button"
            disabled={!dir || !llmOk}
            onClick={() => void toggle()}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-bold text-white disabled:opacity-40 ${
              running ? "bg-red-500/80 hover:bg-red-500" : "btn-flame"
            }`}
          >
            {running ? <LuSquare className="h-3.5 w-3.5" /> : <LuPlay className="h-3.5 w-3.5" />}
            {running ? t("stop") : t("start")}
          </button>
        </div>
        {!llmOk && <p className="mt-2 text-[11.5px] text-red-400">{t("needLlm")}</p>}

        <div ref={listRef} className="mt-4 h-56 overflow-y-auto rounded-xl border border-line bg-panel-2 p-3">
          {events.length === 0 ? (
            <p className="mt-20 text-center text-[12px] text-mut">{running ? t("waiting") : t("empty")}</p>
          ) : (
            <ul className="space-y-1.5">
              {events.map((e, i) => {
                const meta = EVENT_META[e.type];
                return (
                  <li key={`${e.path}-${e.type}-${i}`} className="flex items-start gap-2 text-[12px]">
                    <span className="shrink-0 font-mono text-[11px] text-mut">{fmtTime(e.at)}</span>
                    {e.type === "done" ? (
                      <LuCircleCheck className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${meta.cls}`} />
                    ) : e.type === "error" ? (
                      <LuCircleAlert className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${meta.cls}`} />
                    ) : meta.spin ? (
                      <LuLoaderCircle className={`mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin ${meta.cls}`} />
                    ) : (
                      <LuFileVideo className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${meta.cls}`} />
                    )}
                    <span className="min-w-0">
                      <span className={`font-semibold ${meta.cls}`}>{meta.label}</span>
                      <span className="ml-1.5 break-all text-fg/90">{e.file}</span>
                      {e.type === "done" && <span className="ml-1.5 text-mut">{t("doneClips", { n: e.clips ?? 0 })}</span>}
                      {e.type === "error" && e.message && <span className="ml-1.5 break-all text-mut">{e.message}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <p className="mt-2.5 text-[11px] leading-relaxed text-mut">{t("note")}</p>
      </section>
    </div>
  );
}
