/** Persisted transcription-engine choice (catalog id from shared/asr-catalog). */
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface AsrState {
  engineId: string;
  setEngineId: (id: string) => void;
}

export const useAsrStore = create<AsrState>()(
  persist(
    (set) => ({
      engineId: "sensevoice",
      setEngineId: (engineId) => set({ engineId }),
    }),
    { name: "hotclip-asr" }
  )
);
