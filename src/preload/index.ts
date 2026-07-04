/**
 * Preload: the Electron implementation of the shared HotClipApi contract.
 * The renderer never touches ipcRenderer — only this typed bridge.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { HotClipApi, TranscribeProgressEvent } from "../shared/api-types";

const api: HotClipApi = {
  selectMedia: () => ipcRenderer.invoke("hotclip:select-media"),
  probeMedia: (filePath) => ipcRenderer.invoke("hotclip:probe-media", filePath),
  transcribeMedia: (filePath) => ipcRenderer.invoke("hotclip:transcribe", filePath),
  onTranscribeProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, p: TranscribeProgressEvent): void => cb(p);
    ipcRenderer.on("hotclip:transcribe-progress", listener);
    return () => ipcRenderer.removeListener("hotclip:transcribe-progress", listener);
  },
};

contextBridge.exposeInMainWorld("hotclip", api);
