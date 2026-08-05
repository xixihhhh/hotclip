/**
 * 候选切片审阅台:真实视频预览 + 波形时间轴。
 * - 拖两端手柄逐词微调切点(自动吸附字词边界,拖动时视频跟随蹭帧)
 * - 整句伸缩复用 adjustCandidateBoundary;一键还原 AI 原始切点
 * - 多片段拼接的候选:波形轨换成段清单,播放按段顺序自动跳段(见 shared/pieces)
 * - 播放严格停在切点上,"查结尾"只播最后几秒验收收尾
 * 浏览器预览(mock)没有本地文件 → 视频区退化为提示,时间轴照常可用。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LuPlay,
  LuPause,
  LuX,
  LuRotateCcw,
  LuCheck,
  LuSkipForward,
  LuFilm,
  LuChevronLeft,
  LuChevronRight,
  LuSmartphone,
} from "react-icons/lu";
import { useT, useLocaleStore } from "../i18n/store";
import { getApi } from "../api/provider";
import { adjustCandidateBoundary, piecesText } from "../../../shared/boundary";
import { contextWindow, wordsInWindow, snapToWordEdge, clampDrag, clipText } from "../../../shared/review";
import { piecesDurationSec } from "../../../shared/pieces";
import { SAFE_ZONE_PLATFORMS, zonesFor, fitContain, cropRect9x16 } from "../../../shared/safe-zones";
import type { Transcript, HighlightCandidate, AudioPeaks, ClipPiece } from "../../../shared/api-types";

/** 查结尾:只回放最后这么多秒。 */
const TAIL_PREVIEW_SEC = 2.5;
/** 安全区偏好持久化(开关 + 平台选择)。 */
const SAFEZONE_LS_KEY = "hotclip-safezone";

function loadSafeZonePref(): { on: boolean; platform: string } {
  try {
    const p = JSON.parse(localStorage.getItem(SAFEZONE_LS_KEY) ?? "{}") as { on?: unknown; platform?: unknown };
    return { on: p.on === true, platform: typeof p.platform === "string" ? p.platform : SAFE_ZONE_PLATFORMS[0].id };
  } catch {
    return { on: false, platform: SAFE_ZONE_PLATFORMS[0].id };
  }
}

/** 平台遮挡区遮罩:百分比定位,挂在「代表 9:16 画面」的父盒里,事件全穿透。 */
function SafeZoneMasks({ platformId }: { platformId: string }): React.JSX.Element {
  const p = zonesFor(platformId);
  return (
    <>
      {p.zones.map((z, i) => (
        <div
          key={i}
          className="pointer-events-none absolute rounded-[2px] border border-red-400/50 bg-red-500/20"
          style={{ left: `${z.x * 100}%`, top: `${z.y * 100}%`, width: `${z.w * 100}%`, height: `${z.h * 100}%` }}
        />
      ))}
    </>
  );
}
/** 吸附容差(像素)——换算成秒后交给 snapToWordEdge。 */
const SNAP_TOLERANCE_PX = 8;

function formatClock(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  const ss = (s % 60).toFixed(1).padStart(4, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function ClipReviewModal({
  clip,
  transcript,
  filePath,
  durationSec,
  onSave,
  onClose,
}: {
  clip: HighlightCandidate;
  transcript: Transcript;
  filePath?: string;
  /** 源片总时长,决定上下文窗口的右边界。 */
  durationSec: number;
  onSave: (patch: { startSec: number; endSec: number; text: string; pieces?: ClipPiece[] }) => void;
  onClose: () => void;
}): React.JSX.Element {
  const t = useT("highlights");
  const tc = useT("common");
  const [startSec, setStartSec] = useState(clip.startSec);
  const [endSec, setEndSec] = useState(clip.endSec);
  // 多片段拼接:这条由相隔很远的几段拼成,审阅台要能看清「哪几段、中间跳了多少」
  const [pieces, setPieces] = useState<ClipPiece[]>(clip.pieces ?? []);
  const stitched = pieces.length > 1;
  const [peaks, setPeaks] = useState<AudioPeaks | null>(null);
  // 画面速览:3×3 接触表(打开时按 AI 原始切点取一次;空串 = 不支持/失败,不展示)
  const [sheet, setSheet] = useState("");
  const [playing, setPlaying] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(clip.startSec);
  const [videoFailed, setVideoFailed] = useState(false);
  // 安全区预览:开关+平台选择持久化;裁窗几何随容器尺寸/视频纵横比实时算
  const [safeZone, setSafeZone] = useState(loadSafeZonePref);
  const [videoAr, setVideoAr] = useState(16 / 9);
  const [contSize, setContSize] = useState({ w: 0, h: 0 });
  const videoBoxRef = useRef<HTMLDivElement>(null);
  const locale = useLocaleStore((s) => s.locale);

  const setSafeZonePref = (patch: Partial<{ on: boolean; platform: string }>): void => {
    setSafeZone((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(SAFEZONE_LS_KEY, JSON.stringify(next));
      } catch {
        /* 持久化尽力而为 */
      }
      return next;
    });
  };

  // 视频显示盒尺寸跟踪(窗口缩放/视频加载都要重算裁窗)
  useEffect(() => {
    const el = videoBoxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setContSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // 窗口按打开时的切点固定,波形只取一次;整句伸缩可能越窗,显示时钳到边缘
  const win = useMemo(
    () => contextWindow(clip.startSec, clip.endSec, durationSec),
    [clip.startSec, clip.endSec, durationSec]
  );
  const words = useMemo(() => wordsInWindow(transcript, win.winStartSec, win.winEndSec), [transcript, win]);
  const text = useMemo(
    () => (stitched ? piecesText(transcript, pieces) : clipText(transcript, startSec, endSec)),
    [transcript, stitched, pieces, startSec, endSec]
  );
  const src = useMemo(() => (filePath ? getApi().mediaUrl(filePath) : ""), [filePath]);
  // 成片时长:拼接片是各段之和,不是跨度
  const outDurationSec = stitched ? piecesDurationSec(pieces) : endSec - startSec;
  const dirty =
    Math.abs(startSec - clip.startSec) > 1e-3 ||
    Math.abs(endSec - clip.endSec) > 1e-3 ||
    JSON.stringify(pieces) !== JSON.stringify(clip.pieces ?? []);

  const videoRef = useRef<HTMLVideoElement>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  // 播放循环里读最新切点,避免闭包吃到旧值
  const boundsRef = useRef({ startSec, endSec });
  boundsRef.current = { startSec, endSec };
  const piecesRef = useRef(pieces);
  piecesRef.current = pieces;

  // ---- 波形 ----
  // 拼接片跳过:跨度可能有几十分钟,画出来的波形绝大部分是根本不会进成片的
  // 内容,既误导又要白解码一遍音频
  useEffect(() => {
    if (!filePath || stitched) return;
    let alive = true;
    getApi()
      .getAudioPeaks(filePath, win.winStartSec, win.winEndSec)
      .then((p) => {
        if (alive) setPeaks(p);
      })
      .catch(() => {
        /* 波形失败不致命——时间轴退化为纯色轨 */
      });
    return () => {
      alive = false;
    };
  }, [filePath, win, stitched]);

  // ---- 画面速览(接触表) ----
  // 只按打开时的切点取一次(拖动手柄不重拼——ffmpeg 不该被拖动打爆);失败静默不展示。
  // 拼接片跳过:3×9 均匀抽帧会抽出一堆被剪掉的画面,看着像成片其实不是
  useEffect(() => {
    if (!filePath || stitched) return;
    let alive = true;
    getApi()
      .contactSheet(filePath, clip.startSec, clip.endSec)
      .then((url) => {
        if (alive) setSheet(url);
      })
      .catch(() => {
        /* 速览失败不致命 */
      });
    return () => {
      alive = false;
    };
  }, [filePath, clip.startSec, clip.endSec, stitched]);

  const secToFrac = useCallback(
    (s: number) => Math.max(0, Math.min(1, (s - win.winStartSec) / (win.winEndSec - win.winStartSec))),
    [win]
  );

  // 波形绘制:选中范围内画火焰色,范围外压暗
  const drawWave = useCallback((): void => {
    const canvas = canvasRef.current;
    const lane = laneRef.current;
    if (!canvas || !lane) return;
    const dpr = window.devicePixelRatio || 1;
    const w = lane.clientWidth;
    const h = lane.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    if (!peaks || peaks.values.length === 0) return;
    const css = getComputedStyle(document.documentElement);
    const ember = css.getPropertyValue("--color-ember").trim() || "#ff9a3d";
    const dim = css.getPropertyValue("--color-mut").trim() || "#8f95a3";
    const winDur = win.winEndSec - win.winStartSec;
    for (let x = 0; x < w; x++) {
      const t0 = win.winStartSec + (x / w) * winDur;
      const t1 = win.winStartSec + ((x + 1) / w) * winDur;
      const i0 = Math.max(0, Math.floor((t0 - peaks.startSec) / peaks.hopSec));
      const i1 = Math.min(peaks.values.length - 1, Math.ceil((t1 - peaks.startSec) / peaks.hopSec));
      let peak = 0;
      for (let i = i0; i <= i1; i++) if (peaks.values[i] > peak) peak = peaks.values[i];
      const mid = (t0 + t1) / 2;
      const inRange = mid >= startSec && mid <= endSec;
      const barH = Math.max(1.5, peak * (h - 10));
      ctx.fillStyle = inRange ? ember : dim;
      ctx.globalAlpha = inRange ? 0.95 : 0.28;
      ctx.fillRect(x, (h - barH) / 2, 1, barH);
    }
    ctx.globalAlpha = 1;
  }, [peaks, startSec, endSec, win]);

  useEffect(() => {
    drawWave();
    window.addEventListener("resize", drawWave);
    return () => window.removeEventListener("resize", drawWave);
  }, [drawWave]);

  // ---- 播放控制 ----
  const stopLoop = useCallback((): void => cancelAnimationFrame(rafRef.current), []);

  const tick = useCallback((): void => {
    const v = videoRef.current;
    if (!v) return;
    setPlayheadSec(v.currentTime);
    const ps = piecesRef.current;
    if (ps.length > 1) {
      // 拼接预览:播到本段末尾就跳到下一段开头,最后一段放完即停——
      // 用户在这里看到的顺序就是成片的顺序
      const i = ps.findIndex((p) => v.currentTime < p.endSec - 0.03);
      if (i < 0) {
        v.pause();
        return;
      }
      if (v.currentTime < ps[i].startSec - 0.05) v.currentTime = ps[i].startSec;
    } else if (v.currentTime >= boundsRef.current.endSec - 0.03) {
      // 严格停在切点:审阅的就是"到点收不收得住"
      v.pause();
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const playFrom = useCallback(
    (at: number): void => {
      const v = videoRef.current;
      if (!v) return;
      v.currentTime = at;
      setPlayheadSec(at);
      void v
        .play()
        .then(() => {
          stopLoop();
          rafRef.current = requestAnimationFrame(tick);
        })
        .catch(() => {
          /* 播放被浏览器拒绝(极少)——按钮再点一次即可 */
        });
    },
    [stopLoop, tick]
  );

  const seekTo = useCallback((at: number): void => {
    const v = videoRef.current;
    if (v) v.currentTime = at;
    setPlayheadSec(at);
  }, []);

  useEffect(() => stopLoop, [stopLoop]); // 卸载时停掉播放循环

  // Esc 关闭(不保存)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ---- 拖拽手柄 ----
  const onHandleDown = useCallback(
    (edge: "start" | "end") =>
      (e: React.PointerEvent<HTMLDivElement>): void => {
        e.stopPropagation();
        const lane = laneRef.current;
        if (!lane) return;
        const rect = lane.getBoundingClientRect();
        const winDur = win.winEndSec - win.winStartSec;
        const secPerPx = winDur / rect.width;
        videoRef.current?.pause();

        const move = (ev: PointerEvent): void => {
          const raw = win.winStartSec + (ev.clientX - rect.left) * secPerPx;
          const snapped = snapToWordEdge(raw, words, edge, SNAP_TOLERANCE_PX * secPerPx);
          const other = edge === "start" ? boundsRef.current.endSec : boundsRef.current.startSec;
          const next = clampDrag(edge, snapped, other, win);
          if (edge === "start") setStartSec(next);
          else setEndSec(next);
          seekTo(next); // 拖动即蹭帧——手上的位置就是画面里的位置
        };
        const up = (): void => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      },
    [win, words, seekTo]
  );

  // 点时间轴空白处 → 跳播到该处
  const onLaneDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      const lane = laneRef.current;
      if (!lane) return;
      const rect = lane.getBoundingClientRect();
      const at = win.winStartSec + ((e.clientX - rect.left) / rect.width) * (win.winEndSec - win.winStartSec);
      seekTo(Math.max(win.winStartSec, Math.min(win.winEndSec, at)));
    },
    [win, seekTo]
  );

  // ---- 整句伸缩(复用现有语义句逻辑) ----
  const sentence = useCallback(
    (edge: "start" | "end", dir: 1 | -1): void => {
      // 拼接片只动第一段的起点 / 最后一段的终点(中间段是 AI 挑来做对照的)
      const adj = adjustCandidateBoundary(transcript, { startSec, endSec, pieces }, edge, dir);
      if (!adj) return;
      setStartSec(adj.startSec);
      setEndSec(adj.endSec);
      if (adj.pieces) setPieces(adj.pieces);
      // 查结尾要落在最后一段里,不能拿跨度去减(那会跳到两段中间的空隙)
      const lastStart = adj.pieces?.[adj.pieces.length - 1].startSec ?? adj.startSec;
      seekTo(edge === "start" ? adj.startSec : Math.max(lastStart, adj.endSec - TAIL_PREVIEW_SEC));
    },
    [transcript, stitched, pieces, startSec, endSec, seekTo]
  );

  const reset = useCallback((): void => {
    setStartSec(clip.startSec);
    setEndSec(clip.endSec);
    setPieces(clip.pieces ?? []);
    seekTo(clip.startSec);
  }, [clip.startSec, clip.endSec, clip.pieces, seekTo]);

  const showVideo = src !== "" && !videoFailed;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="card rise-in flex max-h-[92vh] w-full max-w-3xl flex-col overflow-y-auto rounded-2xl p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-lg font-extrabold tracking-tight">
              <LuFilm className="h-4.5 w-4.5 text-ember" />
              {t("reviewTitle")}
            </h2>
            <p className="mt-0.5 truncate text-[12.5px] text-mut">{clip.title}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line p-1.5 text-mut transition-colors hover:border-mut hover:text-fg"
          >
            <LuX className="h-4 w-4" />
          </button>
        </div>

        {/* 视频预览(相对定位承载安全区遮罩) */}
        <div ref={videoBoxRef} className="relative mt-4 overflow-hidden rounded-xl bg-black/60">
          {showVideo ? (
            <video
              ref={videoRef}
              src={src}
              playsInline
              className="mx-auto max-h-[36vh] w-full object-contain"
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                if (v.videoWidth > 0 && v.videoHeight > 0) setVideoAr(v.videoWidth / v.videoHeight);
                seekTo(boundsRef.current.startSec);
              }}
              onPlay={() => setPlaying(true)}
              onPause={() => {
                setPlaying(false);
                stopLoop();
              }}
              onError={() => setVideoFailed(true)}
            />
          ) : (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
              <LuFilm className="h-6 w-6 text-mut" />
              <p className="max-w-md text-[12.5px] leading-relaxed text-mut">
                {src === "" ? t("reviewBrowserStub") : t("reviewNoVideo")}
              </p>
              {/* 浏览器预览没有画面:给一块 9:16 演示框,遮罩形态照常可看 */}
              {safeZone.on && (
                <div
                  className="relative mx-auto mt-2 rounded-md border border-dashed border-fg/40 bg-panel-2"
                  style={{ aspectRatio: "9/16", height: "26vh" }}
                >
                  <SafeZoneMasks platformId={safeZone.platform} />
                </div>
              )}
            </div>
          )}
          {/* 安全区遮罩:先画 9:16 中心裁窗(竖屏成片范围),再叠平台遮挡区 */}
          {safeZone.on && showVideo && contSize.w > 0 && (() => {
            const box = cropRect9x16(fitContain(contSize.w, contSize.h, videoAr));
            return (
              <div
                className="pointer-events-none absolute border border-dashed border-fg/40"
                style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
              >
                <SafeZoneMasks platformId={safeZone.platform} />
              </div>
            );
          })()}
        </div>

        {/* 播放控制 + 时码 */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!showVideo}
            onClick={() => (playing ? videoRef.current?.pause() : playFrom(stitched ? pieces[0].startSec : startSec))}
            className="btn-flame inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-[12.5px] font-bold text-white disabled:opacity-40"
          >
            {playing ? <LuPause className="h-3.5 w-3.5" /> : <LuPlay className="h-3.5 w-3.5" />}
            {playing ? t("reviewPause") : t("reviewPlay")}
          </button>
          <button
            type="button"
            disabled={!showVideo}
            title={t("reviewPlayEndHint")}
            onClick={() => {
              const last = stitched ? pieces[pieces.length - 1] : { startSec, endSec };
              playFrom(Math.max(last.startSec, last.endSec - TAIL_PREVIEW_SEC));
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3.5 py-2 text-[12.5px] font-semibold text-mut transition-colors hover:border-mut hover:text-fg disabled:opacity-40"
          >
            <LuSkipForward className="h-3.5 w-3.5" />
            {t("reviewPlayEnd")}
          </button>
          <button
            type="button"
            title={t("reviewSafeZoneHint")}
            onClick={() => setSafeZonePref({ on: !safeZone.on })}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3.5 py-2 text-[12.5px] font-semibold transition-colors ${
              safeZone.on ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut hover:text-fg"
            }`}
          >
            <LuSmartphone className={`h-3.5 w-3.5 ${safeZone.on ? "text-ember" : ""}`} />
            {t("reviewSafeZone")}
          </button>
          {safeZone.on && (
            <select
              value={safeZone.platform}
              onChange={(e) => setSafeZonePref({ platform: e.target.value })}
              className="rounded-lg border border-line bg-panel-2 px-2 py-2 text-[11.5px] text-mut outline-none focus:border-ember/60"
            >
              {SAFE_ZONE_PLATFORMS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name[locale === "zh" ? "zh" : "en"]}
                </option>
              ))}
            </select>
          )}
          <span className="chip ml-auto rounded-md px-2.5 py-1 font-mono text-[11.5px]">
            {formatClock(startSec)} → {formatClock(endSec)}
            <span className="ml-2 text-ember">{t("durationChip", { n: Math.round(outDurationSec) })}</span>
          </span>
        </div>

        {/* 拼接片:段清单代替波形时间轴——跨度几十分钟的波形毫无意义,
            用户真正要核对的是「剪进去哪几段、中间跳过了多久、拼起来还是不是原意」 */}
        {stitched && (
          <div className="mt-3 rounded-xl border border-ember/40 bg-ember/5 p-3">
            <div className="mb-2 text-[11.5px] font-semibold text-ember">
              {t("stitchedTitle", { n: pieces.length, sec: Math.round(outDurationSec) })}
            </div>
            <div className="flex flex-col gap-1.5">
              {pieces.map((p, i) => (
                <div key={`${p.startSec}-${i}`}>
                  {i > 0 && (
                    <div className="my-1 flex items-center gap-2 pl-1 text-[10.5px] text-mut/80">
                      <span className="h-px flex-1 border-t border-dashed border-line" />
                      {t("stitchedGap", { sec: Math.round(p.startSec - pieces[i - 1].endSec) })}
                      <span className="h-px flex-1 border-t border-dashed border-line" />
                    </div>
                  )}
                  <button
                    type="button"
                    disabled={!showVideo}
                    onClick={() => playFrom(p.startSec)}
                    className="flex w-full items-center gap-2 rounded-lg bg-panel-2 px-2.5 py-1.5 text-left transition-colors hover:bg-panel disabled:opacity-50"
                  >
                    <LuPlay className="h-3 w-3 shrink-0 text-ember" />
                    <span className="shrink-0 font-mono text-[11px] text-mut">
                      {formatClock(p.startSec)} → {formatClock(p.endSec)}
                    </span>
                    <span className="truncate text-[12px] text-fg/85">{piecesText(transcript, [p])}</span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 时间轴:波形 + 选区 + 手柄 + 播放头(拼接片没有连续时间轴可画) */}
        {!stitched && (
        <div
          ref={laneRef}
          onPointerDown={onLaneDown}
          className="relative mt-3 h-16 cursor-pointer touch-none overflow-hidden rounded-xl bg-panel-2"
        >
          <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
          {/* 选区 */}
          <div
            className="pointer-events-none absolute inset-y-0 border-x-2 border-ember/80 bg-ember/10"
            style={{ left: `${secToFrac(startSec) * 100}%`, width: `${(secToFrac(endSec) - secToFrac(startSec)) * 100}%` }}
          />
          {/* 播放头 */}
          <div
            className="pointer-events-none absolute inset-y-0 w-px bg-fg/90"
            style={{ left: `${secToFrac(playheadSec) * 100}%` }}
          />
          {/* 起止手柄 */}
          {(["start", "end"] as const).map((edge) => (
            <div
              key={edge}
              onPointerDown={onHandleDown(edge)}
              className="absolute inset-y-0 flex w-5 -translate-x-1/2 cursor-ew-resize items-center justify-center"
              style={{ left: `${secToFrac(edge === "start" ? startSec : endSec) * 100}%` }}
            >
              <div className="h-9 w-1.5 rounded-full bg-ember shadow-md shadow-black/40" />
            </div>
          ))}
        </div>
        )}
        {!stitched && (
        <div className="mt-1 flex justify-between font-mono text-[10.5px] text-mut/80">
          <span>{formatClock(win.winStartSec)}</span>
          <span>{t("reviewDragHint")}</span>
          <span>{formatClock(win.winEndSec)}</span>
        </div>
        )}

        {/* 整句伸缩 */}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11.5px]">
          {(
            [
              ["start", -1, LuChevronLeft, "nudgeStartBack"],
              ["start", 1, LuChevronRight, "nudgeStartFwd"],
              ["end", -1, LuChevronLeft, "nudgeEndBack"],
              ["end", 1, LuChevronRight, "nudgeEndFwd"],
            ] as const
          ).map(([edge, dir, Icon, key]) => (
            <button
              key={key}
              type="button"
              onClick={() => sentence(edge, dir)}
              className="chip inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 transition-colors hover:text-fg"
            >
              <Icon className="h-3 w-3" />
              {t(key)}
            </button>
          ))}
        </div>

        {/* 画面速览:3×3 接触表,不点播放也能一眼扫完片段画面 */}
        {sheet && (
          <div className="mt-3">
            <div className="mb-1 text-[10.5px] text-mut/80">{t("reviewSheet")}</div>
            <img src={sheet} alt={t("reviewSheet")} className="w-full rounded-xl border border-line" />
          </div>
        )}

        {/* 当前范围文字(校对听不清的地方) */}
        <div className="mt-3 max-h-24 overflow-y-auto rounded-xl bg-panel-2 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-fg/85">
          {text || <span className="text-mut">{t("reviewTextEmpty")}</span>}
        </div>

        {/* 底部动作 */}
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-dashed border-line pt-4">
          <button
            type="button"
            disabled={!dirty}
            onClick={reset}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3.5 py-2 text-[12.5px] font-semibold text-mut transition-colors hover:border-mut hover:text-fg disabled:opacity-40"
          >
            <LuRotateCcw className="h-3.5 w-3.5" />
            {t("reviewReset")}
          </button>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-line px-4 py-2 text-[12.5px] font-semibold text-mut transition-colors hover:border-mut hover:text-fg"
            >
              {tc("cancel")}
            </button>
            <button
              type="button"
              onClick={() =>
                dirty ? onSave({ startSec, endSec, text, pieces: stitched ? pieces : undefined }) : onClose()
              }
              className="btn-flame inline-flex items-center gap-1.5 rounded-lg px-5 py-2 text-[13px] font-bold text-white"
            >
              <LuCheck className="h-4 w-4" />
              {t("reviewSave")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
