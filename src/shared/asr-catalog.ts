/**
 * ASR engine catalog — the platform-neutral facts about every transcription
 * engine the app can offer. Display strings live in renderer i18n keyed by
 * `id`; runtime state (installed) is added by the backend when listing.
 */

export interface AsrEngineFacts {
  id: string;
  kind: "local" | "cloud";
  /** Languages the engine handles well. */
  langs: string[];
  /** Approximate one-time model download, MB (local engines only). */
  sizeMB?: number;
  /** Relative speed tier: 1 = slow … 3 = fast. */
  speed: 1 | 2 | 3;
  /** Relative accuracy tier: 1 = okay … 3 = best. */
  accuracy: 1 | 2 | 3;
  /** True when the user's media must leave the machine. */
  uploads: boolean;
}

/**
 * Order = display order. The first entry is the zero-config default:
 * smallest download, fully offline, five languages.
 */
export const ASR_CATALOG: AsrEngineFacts[] = [
  {
    id: "sensevoice",
    kind: "local",
    langs: ["zh", "yue", "en", "ja", "ko"],
    sizeMB: 170,
    speed: 3,
    accuracy: 2,
    uploads: false,
  },
  {
    id: "paraformer",
    kind: "local",
    langs: ["zh", "en"],
    sizeMB: 230,
    speed: 2,
    accuracy: 3,
    uploads: false,
  },
];
