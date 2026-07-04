/**
 * Preload: the Electron implementation of the shared HotClipApi contract.
 * The renderer never touches ipcRenderer — only this typed bridge.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { HotClipApi } from "../shared/api-types";

const api: HotClipApi = {
  selectMedia: () => ipcRenderer.invoke("hotclip:select-media"),
  probeMedia: (filePath) => ipcRenderer.invoke("hotclip:probe-media", filePath),
};

contextBridge.exposeInMainWorld("hotclip", api);
