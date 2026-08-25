/**
 * 预览区:源画面 16:9 + 竖屏 9:16 中心裁切预览(海报同款发光描边卡)。
 * 视频工具终于能看到视频了——点候选/点时间轴都会把画面 seek 过去。
 * 竖屏卡是第二个 <video> 元素做 CSS 中心裁切,与主画面粗同步
 * (人脸跟随的真实取景在导出层,这里是"竖屏大概长这样"的直觉预览)。
 */
import { useEffect, useRef, useState } from "react";
import { LuPlay, LuPause, LuSkipBack, LuSkipForward } from "react-icons/lu";
import { getApi } from "../../api/provider";
import { useT } from "../../i18n/store";

export interface PreviewTransportCommand {
  id: number;
  action: "toggle" | "back5" | "forward5";
}

function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const mm = String(m).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function PreviewPane({
  filePath,
  durationSec,
  seekSec,
  onTime,
  onPrevCandidate,
  onNextCandidate,
  transportCommand,
}: {
  filePath: string | null;
  durationSec: number;
  /** 外部请求跳播的时刻(时间轴/候选点击驱动;NaN = 无请求)。 */
  seekSec: number;
  onTime: (sec: number) => void;
  onPrevCandidate: () => void;
  onNextCandidate: () => void;
  transportCommand?: PreviewTransportCommand | null;
}): React.JSX.Element {
  const t = useT("workbench");
  const mainRef = useRef<HTMLVideoElement>(null);
  const cropRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [now, setNow] = useState(0);
  // 同一 hotclip-media:// URL 被多个 <video> 同时加载会撞 Chromium 按 URL 共享的媒体缓冲,
  // 自定义协议下两路一起失败且该 URL 本会话内不再可播——每个消费方用 query 区分独享缓冲
  // (serveMedia 只取 pathname,query 不影响鉴权与读文件)
  const srcBase = filePath ? getApi().mediaUrl(filePath) : "";
  const src = srcBase ? `${srcBase}?view=main` : "";
  const cropSrc = srcBase ? `${srcBase}?view=crop` : "";

  // 外部 seek 请求(时间轴点击/候选聚焦)
  useEffect(() => {
    const v = mainRef.current;
    if (!v || !Number.isFinite(seekSec)) return;
    v.currentTime = seekSec;
  }, [seekSec]);

  // 竖屏裁切卡与主画面粗同步:漂移超过 0.3s 才校,别抖
  const syncCrop = (): void => {
    const m = mainRef.current;
    const c = cropRef.current;
    if (!m || !c) return;
    if (Math.abs(c.currentTime - m.currentTime) > 0.3) c.currentTime = m.currentTime;
    if (m.paused !== c.paused) {
      if (m.paused) c.pause();
      else void c.play().catch(() => {});
    }
  };

  const togglePlay = (): void => {
    const v = mainRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  };

  useEffect(() => {
    const video = mainRef.current;
    if (!video || !transportCommand) return;
    if (transportCommand.action === "toggle") {
      if (video.paused) void video.play().catch(() => {});
      else video.pause();
      return;
    }
    const delta = transportCommand.action === "back5" ? -5 : 5;
    video.currentTime = Math.max(0, Math.min(durationSec, video.currentTime + delta));
  }, [durationSec, transportCommand]);

  return (
    <div className="flex shrink-0 flex-col gap-2">
      <div className="flex h-[236px] gap-2.5">
        {/* 源画面 */}
        <div className="relative min-w-0 flex-1 overflow-hidden rounded-xl border border-line/60 bg-black">
          {src ? (
            <video
              ref={mainRef}
              src={src}
              className="h-full w-full object-contain"
              onClick={togglePlay}
              onPlay={() => {
                setPlaying(true);
                syncCrop();
              }}
              onPause={() => {
                setPlaying(false);
                syncCrop();
              }}
              onTimeUpdate={(e) => {
                const sec = (e.target as HTMLVideoElement).currentTime;
                setNow(sec);
                onTime(sec);
                syncCrop();
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-mut">{t("noPreview")}</div>
          )}
          <span className="pointer-events-none absolute top-2 left-2 rounded-md bg-black/55 px-2 py-0.5 text-[10px] text-fg/70">
            {t("sourcePreview")}
          </span>
        </div>
        {/* 竖屏 9:16 中心裁切:发光描边(主视觉海报的切片卡语言) */}
        <div className="relative w-[133px] shrink-0 overflow-hidden rounded-xl border-[1.5px] border-ember/60 bg-black shadow-[0_0_22px_-6px_rgba(255,100,40,0.5)]">
          {src ? (
            <video ref={cropRef} src={cropSrc} muted className="h-full w-full object-cover" />
          ) : (
            <div className="h-full bg-gradient-to-b from-panel-2 to-panel" />
          )}
          <span className="pointer-events-none absolute right-0 bottom-1.5 left-0 text-center text-[9px] text-fg/50">
            {t("verticalPreview")}
          </span>
        </div>
      </div>
      {/* 走带 */}
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={onPrevCandidate}
          className="flex h-7 w-7 items-center justify-center rounded-lg border border-line text-mut transition-colors hover:border-mut hover:text-fg"
        >
          <LuSkipBack className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={togglePlay}
          disabled={!src}
          className="flame-gradient flex h-8 w-8 items-center justify-center rounded-lg text-white disabled:opacity-40"
        >
          {playing ? <LuPause className="h-4 w-4" /> : <LuPlay className="h-4 w-4" />}
        </button>
        <button
          type="button"
          onClick={onNextCandidate}
          className="flex h-7 w-7 items-center justify-center rounded-lg border border-line text-mut transition-colors hover:border-mut hover:text-fg"
        >
          <LuSkipForward className="h-3.5 w-3.5" />
        </button>
        <span className="font-mono text-[12px] tabular-nums">
          {formatClock(now)} <span className="text-mut/50">/ {formatClock(durationSec)}</span>
        </span>
      </div>
    </div>
  );
}
