/** Persisted transcription-engine choice (catalog id from shared/asr-catalog). */
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface AsrState {
  engineId: string;
  /** Per-engine cloud API keys (persisted locally, sent per call). */
  keys: Record<string, string>;
  setEngineId: (id: string) => void;
  setKey: (engineId: string, key: string) => void;
}

export const useAsrStore = create<AsrState>()(
  persist(
    (set) => ({
      engineId: "sensevoice",
      keys: {},
      setEngineId: (engineId) => set({ engineId }),
      setKey: (engineId, key) => set((s) => ({ keys: { ...s.keys, [engineId]: key } })),
    }),
    { name: "hotclip-asr" }
  )
);
