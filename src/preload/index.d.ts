import type { HotClipApi } from "../shared/api-types";

declare global {
  interface Window {
    /** Present only inside Electron (injected by the preload bridge). */
    hotclip?: HotClipApi;
  }
}

export {};
