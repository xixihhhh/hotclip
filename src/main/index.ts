/**
 * Electron main process: window lifecycle + IPC surface.
 * All heavy pipeline work lives in src/core and is invoked from here,
 * never from the renderer directly.
 */
import { app, shell, BrowserWindow, ipcMain, dialog } from "electron";
import { join } from "path";
import { probeMedia } from "@core/probe";
import { SenseVoiceEngine } from "@core/transcribe/sensevoice";

const VIDEO_EXTENSIONS = ["mp4", "mkv", "mov", "flv", "ts", "webm", "avi", "m4v"];
const AUDIO_EXTENSIONS = ["mp3", "m4a", "wav", "aac", "flac"];

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: "HotClip",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on("ready-to-show", () => mainWindow.show());

  // External links open in the system browser, never inside the app shell.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

// ---- IPC: file import + probing (wizard step 1) ----

ipcMain.handle("hotclip:select-media", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [
      { name: "Video / Audio", extensions: [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle("hotclip:probe-media", async (_event, filePath: unknown) => {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error("probe-media requires a file path");
  }
  return probeMedia(filePath);
});

// ---- IPC: transcription (wizard step 2) ----
// Engine instances are cheap; the model itself is downloaded once into userData.

let transcribing = false;

ipcMain.handle("hotclip:transcribe", async (event, filePath: unknown) => {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error("transcribe requires a file path");
  }
  if (transcribing) throw new Error("another transcription is already running");
  transcribing = true;
  try {
    const modelsRoot = join(app.getPath("userData"), "models");
    const engine = new SenseVoiceEngine(modelsRoot);
    return await engine.transcribe(filePath, {
      onProgress: (p) => {
        // renderer may already be gone on quit — guard the send
        if (!event.sender.isDestroyed()) event.sender.send("hotclip:transcribe-progress", p);
      },
    });
  } finally {
    transcribing = false;
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
