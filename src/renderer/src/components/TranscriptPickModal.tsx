/**
 * 文稿选段弹窗(文字剪视频):整篇逐句稿铺开,点句子选中/取消,选好直接成片。
 * - 不相邻的句子自动拼接(复用 pieces 机器:跳剪/字幕/EDL/质检全对齐)
 * - 多人对话(diarize)开启后按说话人筛选——「只看嘉宾说的」一眼挑完
 * - 搜台词定位记忆里的那句话;选中集不随筛选丢失
 * 纯 UI:成片规则(合段/上限)全在 shared/pick.ts,两边共享一份代码。
 */
import { useMemo, useState } from "react";
import { LuTextSelect, LuX, LuSearch, LuCheck, LuPlus, LuEraser } from "react-icons/lu";
import { useT } from "../i18n/store";
import { selectionToPieces, pickVerdict, MANUAL_MAX_PIECES } from "../../../shared/pick";
import { piecesText } from "../../../shared/boundary";
import { piecesDurationSec } from "../../../shared/pieces";
import type { Transcript, ClipPiece } from "../../../shared/api-types";

/** 说话人徽标配色:按 speaker id 轮转,与人无关只求区分。 */
const SPK_COLORS = [
  "text-sky-400 border-sky-400/40",
  "text-emerald-400 border-emerald-400/40",
  "text-amber-300 border-amber-300/40",
  "text-pink-400 border-pink-400/40",
  "text-violet-400 border-violet-400/40",
  "text-teal-300 border-teal-300/40",
];

function fmtTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function TranscriptPickModal({
  transcript,
  onAdd,
  onClose,
}: {
  transcript: Transcript;
  /** 选段成片:段清单(时间序)+ 覆盖文本 + 默认标题。 */
  onAdd: (pieces: ClipPiece[], text: string, title: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const t = useT("highlights");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState("");
  /** null = 全部说话人。 */
  const [speakerFilter, setSpeakerFilter] = useState<number | null>(null);

  // 说话人清单:≥2 人才值得筛(单人筛选没有意义)
  const speakers = useMemo(() => {
    const ids = new Set<number>();
    for (const s of transcript.segments) if (s.speaker !== undefined) ids.add(s.speaker);
    return [...ids].sort((a, b) => a - b);
  }, [transcript]);

  const q = query.trim().toLowerCase();
  const visible = transcript.segments.filter(
    (seg) =>
      (speakerFilter === null || seg.speaker === speakerFilter) &&
      (!q || seg.text.toLowerCase().includes(q))
  );

  const pieces = useMemo(() => selectionToPieces(transcript.segments, selected), [transcript, selected]);
  const durationSec = piecesDurationSec(pieces);
  const verdict = pickVerdict(pieces, durationSec);

  const toggle = (id: number): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const add = (): void => {
    if (verdict !== "ok") return;
    // 默认标题取第一句开头(标题在候选卡上随时可改)
    const first = transcript.segments.find((seg) => selected.has(seg.id));
    const title = (first?.text ?? "").trim().slice(0, 24) || t("pickButton");
    onAdd(pieces, piecesText(transcript, pieces), title);
  };

  // 选空/正常都显示统计;违规时把原因写在统计位上(按钮同时禁用)
  const problem =
    verdict === "tooShort" ? t("pickTooShort")
    : verdict === "tooLong" ? t("pickTooLong")
    : verdict === "tooMany" ? t("pickTooMany", { max: MANUAL_MAX_PIECES })
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="card flex max-h-[86vh] w-full max-w-2xl flex-col rounded-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-lg font-extrabold tracking-tight">
              <LuTextSelect className="h-5 w-5 text-ember" />
              {t("pickTitle")}
            </h2>
            <p className="mt-1 text-[12px] leading-relaxed text-mut">{t("pickDesc")}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg p-1.5 text-mut transition-colors hover:bg-white/5 hover:text-fg"
          >
            <LuX className="h-4 w-4" />
          </button>
        </div>

        {/* 搜索 + 说话人筛选 */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <LuSearch className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-mut" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("pickSearch")}
              className="w-full rounded-lg border border-line bg-panel-2 py-2 pr-3 pl-8 text-xs outline-none transition-colors focus:border-ember/60"
            />
          </div>
          {speakers.length >= 2 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setSpeakerFilter(null)}
                className={`chip rounded-md px-2 py-1 text-[11px] font-semibold transition-colors ${
                  speakerFilter === null ? "border-ember/60 bg-ember/10 text-fg" : "text-mut hover:text-fg"
                }`}
              >
                {t("pickAllSpeakers")}
              </button>
              {speakers.map((id) => (
                <button
                  key={id}
                  type="button"
                  title={t("pickSpeakerHint", { n: id + 1 })}
                  onClick={() => setSpeakerFilter((prev) => (prev === id ? null : id))}
                  className={`chip rounded-md border px-2 py-1 text-[11px] font-bold transition-colors ${
                    SPK_COLORS[id % SPK_COLORS.length]
                  } ${speakerFilter === id ? "bg-ember/10" : "opacity-70 hover:opacity-100"}`}
                >
                  S{id + 1}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 逐句稿:点句选中/取消 */}
        <div className="mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
          {visible.length === 0 && (
            <p className="py-8 text-center text-sm text-mut">{t("pickNoMatch")}</p>
          )}
          {visible.map((seg) => {
            const on = selected.has(seg.id);
            return (
              <button
                key={seg.id}
                type="button"
                onClick={() => toggle(seg.id)}
                className={`flex w-full items-start gap-2.5 rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
                  on ? "border-ember/50 bg-ember/10" : "border-transparent hover:bg-white/5"
                }`}
              >
                <span
                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                    on ? "flame-gradient border-transparent text-white" : "border-line text-transparent"
                  }`}
                >
                  <LuCheck className="h-3 w-3" />
                </span>
                <span className="mt-0.5 shrink-0 font-mono text-[10.5px] text-mut">{fmtTime(seg.startSec)}</span>
                {seg.speaker !== undefined && speakers.length >= 2 && (
                  <span
                    className={`mt-0.5 shrink-0 rounded border px-1 font-mono text-[10px] font-bold ${
                      SPK_COLORS[seg.speaker % SPK_COLORS.length]
                    }`}
                  >
                    S{seg.speaker + 1}
                  </span>
                )}
                <span className={`min-w-0 text-[13px] leading-relaxed ${on ? "text-fg" : "text-fg/80"}`}>
                  {seg.text}
                </span>
              </button>
            );
          })}
        </div>

        {/* 状态 + 动作 */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-dashed border-line pt-3">
          <span className={`text-[12px] font-semibold ${problem ? "text-amber-400" : "text-mut"}`}>
            {problem ?? t("pickStat", { sents: selected.size, pieces: pieces.length, sec: Math.round(durationSec) })}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={selected.size === 0}
              onClick={() => setSelected(new Set())}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3.5 py-2 text-xs font-semibold text-mut transition-colors hover:border-mut hover:text-fg disabled:opacity-40"
            >
              <LuEraser className="h-3.5 w-3.5" />
              {t("pickClear")}
            </button>
            <button
              type="button"
              disabled={verdict !== "ok"}
              onClick={add}
              className="btn-flame inline-flex items-center gap-1.5 rounded-lg px-5 py-2 text-xs font-bold text-white disabled:opacity-40"
            >
              <LuPlus className="h-3.5 w-3.5" />
              {t("pickAdd")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
