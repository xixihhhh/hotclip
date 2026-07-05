/**
 * Preload: the Electron implementation of the shared HotClipApi contract.
 * The renderer never touches ipcRenderer — only this typed bridge.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { HotClipApi, TranscribeProgressEvent, ExportProgressEvent } from "../shared/api-types";

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
  detectHighlights: (transcript, llm, filePath, diarize) =>
    ipcRenderer.invoke("hotclip:detect-highlights", transcript, llm, filePath, diarize),
  exportClips: (filePath, clips, options) => ipcRenderer.invoke("hotclip:export-clips", filePath, clips, options),
  onExportProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, p: ExportProgressEvent): void => cb(p);
    ipcRenderer.on("hotclip:export-progress", listener);
    return () => ipcRenderer.removeListener("hotclip:export-progress", listener);
  },
  revealClip: (path) => ipcRenderer.send("hotclip:reveal", path),
};

contextBridge.exposeInMainWorld("hotclip", api);
