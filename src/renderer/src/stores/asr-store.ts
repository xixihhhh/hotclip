/** Persisted transcription-engine choice (catalog id from shared/asr-catalog). */
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface AsrState {
  engineId: string;
  localServiceUrl: string;
  setLocalServiceUrl: (url: string) => void;
  /** Per-engine cloud API keys (persisted locally, sent per call). */
  keys: Record<string, string>;
  setEngineId: (id: string) => void;
  setKey: (engineId: string, key: string) => void;
}

export const useAsrStore = create<AsrState>()(
  persist(
    (set) => ({
      engineId: "sensevoice",
      localServiceUrl: "http://127.0.0.1:8766",
      setLocalServiceUrl: (localServiceUrl) => set({ localServiceUrl }),
      keys: {},
      setEngineId: (engineId) => set({ engineId }),
      setKey: (engineId, key) => set((s) => ({ keys: { ...s.keys, [engineId]: key } })),
    }),
    { name: "hotclip-asr" }
  )
);
