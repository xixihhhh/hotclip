import { useEffect, useMemo, useState } from "react";
import { LuFileClock, LuFileWarning, LuFolderInput, LuFolderOpen, LuPencil, LuSearch, LuTrash2, LuX } from "react-icons/lu";
import type { ProjectSourceStatus, ProjectSummary } from "../../../shared/api-types";
import { useLocaleStore, useT } from "../i18n/store";

interface Props {
  projects: ProjectSummary[];
  activeProjectId: string | null;
  onClose: () => void;
  onNew: () => Promise<void>;
  onOpen: (id: string) => Promise<void>;
  onRelink: (id: string) => Promise<boolean>;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

const STATUS_CLASS: Record<ProjectSourceStatus, string> = {
  ready: "border-emerald-400/25 bg-emerald-400/8 text-emerald-300",
  offline: "border-amber-400/25 bg-amber-400/8 text-amber-200",
  changed: "border-orange-400/25 bg-orange-400/8 text-orange-200",
  corrupt: "border-red-400/25 bg-red-400/8 text-red-300",
};

export function ProjectLibraryModal({ projects, activeProjectId, onClose, onNew, onOpen, onRelink, onRename, onDelete }: Props): React.JSX.Element {
  const t = useT("projects");
  const { locale } = useLocaleStore();
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busyId) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busyId, onClose]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return projects;
    return projects.filter((project) => `${project.name}\n${project.sourceName}\n${project.sourcePath}`.toLocaleLowerCase().includes(needle));
  }, [projects, query]);

  const formatTime = (value: string): string => {
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date)
      : value;
  };

  const run = async (id: string, action: () => Promise<void>): Promise<void> => {
    setBusyId(id);
    setError(null);
    try {
      await action();
    } catch {
      setError(t("actionFailed"));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-5 backdrop-blur-sm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busyId) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="project-library-title" className="flex max-h-[82vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl">
        <header className="flex items-start gap-4 border-b border-line/70 px-5 py-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-ember/25 bg-ember/10 text-ember">
            <LuFolderOpen className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="project-library-title" className="text-[15px] font-extrabold text-fg">{t("title")}</h2>
            <p className="mt-1 max-w-2xl text-[11.5px] leading-relaxed text-mut">{t("desc")}</p>
          </div>
          <button type="button" onClick={onClose} disabled={Boolean(busyId)} title={t("close")} className="rounded-lg p-2 text-mut transition-colors hover:bg-white/5 hover:text-fg disabled:opacity-40">
            <LuX className="h-4 w-4" />
          </button>
        </header>

        <div className="flex items-center gap-3 border-b border-line/60 px-5 py-3">
          <label className="relative min-w-0 flex-1">
            <LuSearch className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-mut/70" />
            <span className="sr-only">{t("search")}</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("search")} className="w-full rounded-lg border border-line bg-panel-2 py-2 pr-3 pl-9 text-[12px] text-fg outline-none transition-colors placeholder:text-mut/60 focus:border-ember/50" />
          </label>
          <button type="button" onClick={() => void run("new", onNew)} disabled={Boolean(busyId)} className="btn-flame inline-flex shrink-0 items-center gap-2 rounded-lg px-4 py-2 text-[12px] font-bold text-white disabled:opacity-45">
            <LuFolderInput className="h-4 w-4" />
            {t("newProject")}
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {filtered.length === 0 ? (
            <div className="flex min-h-48 items-center justify-center rounded-xl border border-dashed border-line/70 text-center text-[12px] text-mut">{t("empty")}</div>
          ) : (
            <div className="grid gap-2.5">
              {filtered.map((project) => {
                const active = project.id === activeProjectId;
                const unavailable = project.status !== "ready";
                const busy = busyId === project.id;
                return (
                  <article key={project.id} className={`rounded-xl border p-3.5 transition-colors ${active ? "border-ember/45 bg-ember/5" : "border-line/80 bg-panel-2/45 hover:border-mut/70"}`}>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                      <div className="flex min-w-0 flex-1 items-start gap-3">
                        <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${unavailable ? STATUS_CLASS[project.status] : "border-line bg-white/3 text-mut"}`}>
                          {unavailable ? <LuFileWarning className="h-4 w-4" /> : <LuFileClock className="h-4 w-4" />}
                        </div>
                        <div className="min-w-0 flex-1">
                        {editingId === project.id ? (
                          <form className="flex max-w-md gap-2" onSubmit={(event) => { event.preventDefault(); void run(project.id, async () => { await onRename(project.id, name); setEditingId(null); }); }}>
                            <label className="min-w-0 flex-1">
                              <span className="sr-only">{t("renamePlaceholder")}</span>
                              <input autoFocus value={name} maxLength={80} onChange={(event) => setName(event.target.value)} className="w-full rounded-md border border-ember/50 bg-panel px-2.5 py-1.5 text-[12px] text-fg outline-none" />
                            </label>
                            <button type="submit" disabled={!name.trim() || busy} className="rounded-md border border-line px-2.5 text-[11px] font-semibold text-fg disabled:opacity-40">{t("saveName")}</button>
                          </form>
                        ) : (
                          <div className="flex min-w-0 items-center gap-2">
                            <h3 className="truncate text-[12.5px] font-bold text-fg" title={project.name}>{project.name}</h3>
                            <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[9.5px] font-semibold ${STATUS_CLASS[project.status]}`}>{t(project.status)}</span>
                          </div>
                        )}
                        <p className="mt-1 truncate font-mono text-[10.5px] text-mut/80" title={project.sourcePath}>{project.sourceName}</p>
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-mut/70">
                          <span>{project.hasTranscript ? t("transcriptReady") : t("transcriptPending")}</span>
                          <span>{t("candidates", { n: project.candidateCount })}</span>
                          <span>{t("updated", { time: formatTime(project.updatedAt) })}</span>
                        </div>
                        {unavailable && project.status !== "corrupt" && <p className="mt-2 text-[10.5px] text-amber-200/80">{t("relinkHint")}</p>}
                        {project.status === "corrupt" && <p className="mt-2 text-[10.5px] text-red-300/80">{t("relinkFailed")}</p>}
                        </div>
                      </div>

                      <div className="flex w-full shrink-0 items-center justify-end gap-1.5 sm:w-auto">
                        {project.status === "ready" ? (
                          <button type="button" disabled={active || Boolean(busyId)} onClick={() => void run(project.id, () => onOpen(project.id))} className={`rounded-lg border px-3 py-1.5 text-[11px] font-bold transition-colors disabled:opacity-55 ${active ? "border-ember/35 bg-ember/10 text-ember" : "border-line text-fg hover:border-ember/45 hover:text-ember"}`}>
                            {active ? t("current") : t("open")}
                          </button>
                        ) : project.status !== "corrupt" ? (
                          <button type="button" disabled={Boolean(busyId)} onClick={() => void run(project.id, async () => { if (!(await onRelink(project.id))) setError(t("relinkFailed")); })} className="rounded-lg border border-amber-400/30 px-3 py-1.5 text-[11px] font-bold text-amber-200 transition-colors hover:border-amber-300/60 disabled:opacity-45">{t("relink")}</button>
                        ) : null}
                        <button type="button" disabled={Boolean(busyId)} onClick={() => { setEditingId(project.id); setName(project.name); setConfirmDeleteId(null); }} title={t("rename")} className="rounded-lg border border-line p-1.5 text-mut transition-colors hover:border-mut hover:text-fg disabled:opacity-40"><LuPencil className="h-3.5 w-3.5" /></button>
                        <button type="button" disabled={Boolean(busyId)} onClick={() => { if (confirmDeleteId !== project.id) { setConfirmDeleteId(project.id); setEditingId(null); return; } void run(project.id, () => onDelete(project.id)); }} title={t("deleteHint")} className={`rounded-lg border px-2 py-1.5 text-[10.5px] font-semibold transition-colors disabled:opacity-40 ${confirmDeleteId === project.id ? "border-red-400/45 bg-red-400/10 text-red-300" : "border-line text-mut hover:border-red-400/35 hover:text-red-300"}`}>
                          {confirmDeleteId === project.id ? t("deleteConfirm") : <LuTrash2 className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          {error && <p role="alert" className="mt-3 text-[11.5px] text-red-400">{error}</p>}
        </div>
      </section>
    </div>
  );
}
