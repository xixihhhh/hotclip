/**
 * Preload: the Electron implementation of the shared HotClipApi contract.
 * The renderer never touches ipcRenderer — only this typed bridge.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { HotClipApi, TranscribeProgressEvent, ExportProgressEvent, WatchEvent } from "../shared/api-types";

const api: HotClipApi = {
  selectMedia: () => ipcRenderer.invoke("hotclip:select-media"),
  probeMedia: (filePath) => ipcRenderer.invoke("hotclip:probe-media", filePath),
  listAsrEngines: () => ipcRenderer.invoke("hotclip:list-asr-engines"),
  transcribeMedia: (filePath, engineId, apiKey) => ipcRenderer.invoke("hotclip:transcribe", filePath, engineId, apiKey),
  onTranscribeProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, p: TranscribeProgressEvent): void => cb(p);
    ipcRenderer.on("hotclip:transcribe-progress", listener);
    return () => ipcRenderer.removeListener("hotclip:transcribe-progress", listener);
  },
  detectHighlights: (transcript, llm, filePath, diarize, prefilter, vision, length) =>
    ipcRenderer.invoke("hotclip:detect-highlights", transcript, llm, filePath, diarize, prefilter, vision, length),
  exportClips: (filePath, clips, options) => ipcRenderer.invoke("hotclip:export-clips", filePath, clips, options),
  onExportProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, p: ExportProgressEvent): void => cb(p);
    ipcRenderer.on("hotclip:export-progress", listener);
    return () => ipcRenderer.removeListener("hotclip:export-progress", listener);
  },
  cancelExport: () => ipcRenderer.send("hotclip:export-cancel"),
  revealClip: (path) => ipcRenderer.send("hotclip:reveal", path),
  // 路径整体编码进 pathname,主进程协议按同样规则解回
  mediaUrl: (filePath) => `hotclip-media://local/${encodeURIComponent(filePath)}`,
  selectImage: () => ipcRenderer.invoke("hotclip:select-image"),
  getAudioPeaks: (filePath, startSec, endSec) =>
    ipcRenderer.invoke("hotclip:audio-peaks", filePath, startSec, endSec),
  selectDir: () => ipcRenderer.invoke("hotclip:select-dir"),
  watchStart: (dir, llm) => ipcRenderer.invoke("hotclip:watch-start", dir, llm),
  watchStop: () => ipcRenderer.invoke("hotclip:watch-stop"),
  watchStatus: () => ipcRenderer.invoke("hotclip:watch-status"),
  onWatchEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, p: WatchEvent): void => cb(p);
    ipcRenderer.on("hotclip:watch-event", listener);
    return () => ipcRenderer.removeListener("hotclip:watch-event", listener);
  },
  checkUpdate: () => ipcRenderer.invoke("hotclip:check-update"),
  openUrl: (url) => ipcRenderer.send("hotclip:open-url", url),
};

contextBridge.exposeInMainWorld("hotclip", api);
