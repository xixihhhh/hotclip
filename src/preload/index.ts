/**
 * Preload: the Electron implementation of the shared HotClipApi contract.
 * The renderer never touches ipcRenderer — only this typed bridge.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { HotClipApi, TranscribeProgressEvent, ExportProgressEvent, UrlImportProgressEvent, WatchEvent, DiagnosticsProgressEvent } from "../shared/api-types";

const api: HotClipApi = {
  selectMedia: () => ipcRenderer.invoke("hotclip:select-media"),
  importMediaUrl: (url) => ipcRenderer.invoke("hotclip:import-media-url", url),
  onUrlImportProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, p: UrlImportProgressEvent): void => cb(p);
    ipcRenderer.on("hotclip:url-import-progress", listener);
    return () => ipcRenderer.removeListener("hotclip:url-import-progress", listener);
  },
  cancelUrlImport: () => ipcRenderer.send("hotclip:url-import-cancel"),
  projectWorkspaceGet: () => ipcRenderer.invoke("hotclip:project-workspace-get"),
  projectCreate: (checkpoint, name) => ipcRenderer.invoke("hotclip:project-create", checkpoint, name),
  projectOpen: (id) => ipcRenderer.invoke("hotclip:project-open", id),
  projectSave: (id, checkpoint) => ipcRenderer.invoke("hotclip:project-save", id, checkpoint),
  projectRename: (id, name) => ipcRenderer.invoke("hotclip:project-rename", id, name),
  projectDelete: (id) => ipcRenderer.invoke("hotclip:project-delete", id),
  projectRelink: (id, filePath) => ipcRenderer.invoke("hotclip:project-relink", id, filePath),
  projectClose: () => ipcRenderer.invoke("hotclip:project-close"),
  sessionCheckpointGet: () => ipcRenderer.invoke("hotclip:session-checkpoint-get"),
  sessionCheckpointSave: (checkpoint) => ipcRenderer.invoke("hotclip:session-checkpoint-save", checkpoint),
  sessionCheckpointClear: () => ipcRenderer.invoke("hotclip:session-checkpoint-clear"),
  probeMedia: (filePath) => ipcRenderer.invoke("hotclip:probe-media", filePath),
  listAsrEngines: () => ipcRenderer.invoke("hotclip:list-asr-engines"),
  transcribeMedia: (filePath, engineId, apiKey) => ipcRenderer.invoke("hotclip:transcribe", filePath, engineId, apiKey),
  onTranscribeProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, p: TranscribeProgressEvent): void => cb(p);
    ipcRenderer.on("hotclip:transcribe-progress", listener);
    return () => ipcRenderer.removeListener("hotclip:transcribe-progress", listener);
  },
  detectHighlights: (transcript, llm, filePath, diarize, prefilter, vision, length, products, referencePath, genre, brief, scan) =>
    ipcRenderer.invoke("hotclip:detect-highlights", transcript, llm, filePath, diarize, prefilter, vision, length, products, referencePath, genre, brief, scan),
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
  selectAudio: () => ipcRenderer.invoke("hotclip:select-audio"),
  generateBgm: (config, genreId) => ipcRenderer.invoke("hotclip:generate-bgm", config, genreId),
  getAudioPeaks: (filePath, startSec, endSec) =>
    ipcRenderer.invoke("hotclip:audio-peaks", filePath, startSec, endSec),
  timelineData: (filePath, durationSec) => ipcRenderer.invoke("hotclip:timeline-data", filePath, durationSec),
  contactSheet: (filePath, startSec, endSec) =>
    ipcRenderer.invoke("hotclip:contact-sheet", filePath, startSec, endSec),
  listLlmModels: (baseUrl, apiKey) => ipcRenderer.invoke("hotclip:llm-models", baseUrl, apiKey),
  recordReview: (video, kept, rejected) => ipcRenderer.invoke("hotclip:review-record", video, kept, rejected),
  performanceGet: () => ipcRenderer.invoke("hotclip:performance-get"),
  performanceImport: () => ipcRenderer.invoke("hotclip:performance-import"),
  performanceTemplate: () => ipcRenderer.invoke("hotclip:performance-template"),
  performanceClear: () => ipcRenderer.invoke("hotclip:performance-clear"),
  diagnosticsRun: (llm, locale) => ipcRenderer.invoke("hotclip:diagnostics-run", llm, locale),
  diagnosticsClearRenderCache: (llm, locale) => ipcRenderer.invoke("hotclip:diagnostics-clear-render-cache", llm, locale),
  diagnosticsClearEvidenceIndex: (llm, locale) => ipcRenderer.invoke("hotclip:diagnostics-clear-evidence-index", llm, locale),
  diagnosticsPrepareModels: (llm, locale) => ipcRenderer.invoke("hotclip:diagnostics-prepare-models", llm, locale),
  onDiagnosticsProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, p: DiagnosticsProgressEvent): void => cb(p);
    ipcRenderer.on("hotclip:diagnostics-progress", listener);
    return () => ipcRenderer.removeListener("hotclip:diagnostics-progress", listener);
  },
  diagnosticsCancelRepair: () => ipcRenderer.send("hotclip:diagnostics-repair-cancel"),
  selectDir: () => ipcRenderer.invoke("hotclip:select-dir"),
  defaultOutDir: () => ipcRenderer.invoke("hotclip:default-out-dir"),
  modelsInfo: () => ipcRenderer.invoke("hotclip:models-info"),
  moveModelsDir: (dir) => ipcRenderer.invoke("hotclip:models-move", dir),
  openFolder: (path) => ipcRenderer.send("hotclip:open-folder", path),
  watchStart: (dir, llm, outDir) => ipcRenderer.invoke("hotclip:watch-start", dir, llm, outDir),
  watchStop: () => ipcRenderer.invoke("hotclip:watch-stop"),
  watchStatus: () => ipcRenderer.invoke("hotclip:watch-status"),
  automationTasksGet: () => ipcRenderer.invoke("hotclip:automation-tasks-get"),
  automationTaskRetry: (id, llm, outDir) => ipcRenderer.invoke("hotclip:automation-task-retry", id, llm, outDir),
  automationTaskCancel: (id) => ipcRenderer.invoke("hotclip:automation-task-cancel", id),
  automationTasksClear: () => ipcRenderer.invoke("hotclip:automation-tasks-clear"),
  webhookStart: (dir, llm, outDir, port, token) =>
    ipcRenderer.invoke("hotclip:webhook-start", dir, llm, outDir, port, token),
  webhookStop: () => ipcRenderer.invoke("hotclip:webhook-stop"),
  webhookStatus: () => ipcRenderer.invoke("hotclip:webhook-status"),
  onWatchEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, p: WatchEvent): void => cb(p);
    ipcRenderer.on("hotclip:watch-event", listener);
    return () => ipcRenderer.removeListener("hotclip:watch-event", listener);
  },
  checkUpdate: () => ipcRenderer.invoke("hotclip:check-update"),
  openUrl: (url) => ipcRenderer.send("hotclip:open-url", url),
  glossaryGet: () => ipcRenderer.invoke("hotclip:glossary-get"),
  glossarySet: (entries) => ipcRenderer.invoke("hotclip:glossary-set", entries),
};

contextBridge.exposeInMainWorld("hotclip", api);
