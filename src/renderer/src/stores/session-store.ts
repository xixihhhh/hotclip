/**
 * 会话 store:一次剪辑会话的全部工作状态(素材/逐句稿/候选/检测统计/导出)。
 * 原先这些活在 App.tsx 与 HighlightsView 的 useState 里——回退一步候选就全丢,
 * 重新检测又是一轮 LLM 花费。进 store 后视图随便切,结果一直在。
 *
 * 不持久化:候选与逐句稿绑定具体素材,跨启动恢复意义不大且易脏;
 * 出片偏好等长期记忆仍在 render-prefs / llm / asr 各自的 store 里。
 */
import { create } from "zustand";
import type {
  MediaInfo,
  Transcript,
  HighlightCandidate,
  RenderToggles,
  FunnelStats,
  VisionStats,
  EmotionStats,
  DanmakuStats,
  VoiceTagStats,
  ReferenceInfo,
} from "../../../shared/api-types";

export interface ProbedFile extends MediaInfo {
  path: string;
}

/** 检测阶段随结果带回的各路信号统计(展示用)。 */
export interface DetectStats {
  funnel: FunnelStats | null;
  vision: VisionStats | null;
  emotion: EmotionStats | null;
  danmaku: DanmakuStats | null;
  voice: VoiceTagStats | null;
  reference: ReferenceInfo | null;
  referenceError: string | null;
}

export const EMPTY_STATS: DetectStats = {
  funnel: null,
  vision: null,
  emotion: null,
  danmaku: null,
  voice: null,
  reference: null,
  referenceError: null,
};

interface SessionState {
  file: ProbedFile | null;
  transcript: Transcript | null;
  /** 托管模式:每一步自动推进(导入卡上的「一键托管」)。 */
  auto: boolean;
  /** 设置中心(全屏视图,盖在工作台之上;任何时刻可达)。 */
  settingsOpen: boolean;

  candidates: HighlightCandidate[] | null;
  /** 勾选出片的候选 id。 */
  selected: Set<number>;
  /** 右栏正在查看详情的候选 id(与勾选无关)。 */
  focusedId: number | null;
  detecting: boolean;
  detectError: string | null;
  stats: DetectStats;

  /** 检测参数(会话内):改动只标脏,点「重新检测」才生效——不再静默重跑。 */
  diarize: boolean;
  referencePath: string | null;
  paramsDirty: boolean;

  exporting: { clips: HighlightCandidate[]; options: RenderToggles } | null;

  setFile: (file: ProbedFile | null) => void;
  setTranscript: (t: Transcript | null) => void;
  setAuto: (v: boolean) => void;
  setSettingsOpen: (v: boolean) => void;
  setCandidates: (c: HighlightCandidate[] | null) => void;
  patchCandidate: (id: number, patch: Partial<HighlightCandidate>) => void;
  setSelected: (ids: Set<number>) => void;
  toggleSelected: (id: number) => void;
  setFocusedId: (id: number | null) => void;
  setDetecting: (v: boolean) => void;
  setDetectError: (msg: string | null) => void;
  setStats: (s: DetectStats) => void;
  setDiarize: (v: boolean) => void;
  setReferencePath: (p: string | null) => void;
  markParamsDirty: (v: boolean) => void;
  setExporting: (v: { clips: HighlightCandidate[]; options: RenderToggles } | null) => void;
  /** 换素材/重开:回到导入态,清空一切会话状态。 */
  reset: () => void;
}

export const useSession = create<SessionState>((set, get) => ({
  file: null,
  transcript: null,
  auto: false,
  settingsOpen: false,
  candidates: null,
  selected: new Set<number>(),
  focusedId: null,
  detecting: false,
  detectError: null,
  stats: EMPTY_STATS,
  diarize: false,
  referencePath: null,
  paramsDirty: false,
  exporting: null,

  setFile: (file) => set({ file }),
  setTranscript: (transcript) => set({ transcript }),
  setAuto: (auto) => set({ auto }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setCandidates: (candidates) => set({ candidates }),
  patchCandidate: (id, patch) =>
    set({
      candidates: (get().candidates ?? []).map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }),
  setSelected: (selected) => set({ selected }),
  toggleSelected: (id) => {
    const next = new Set(get().selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ selected: next });
  },
  setFocusedId: (focusedId) => set({ focusedId }),
  setDetecting: (detecting) => set({ detecting }),
  setDetectError: (detectError) => set({ detectError }),
  setStats: (stats) => set({ stats }),
  setDiarize: (diarize) => set({ diarize }),
  setReferencePath: (referencePath) => set({ referencePath }),
  markParamsDirty: (paramsDirty) => set({ paramsDirty }),
  setExporting: (exporting) => set({ exporting }),
  reset: () =>
    set({
      file: null,
      transcript: null,
      auto: false,
      candidates: null,
      selected: new Set<number>(),
      focusedId: null,
      detecting: false,
      detectError: null,
      stats: EMPTY_STATS,
      diarize: false,
      referencePath: null,
      paramsDirty: false,
      exporting: null,
    }),
}));
