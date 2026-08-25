/**
 * 会话 store:一次剪辑会话的全部工作状态(素材/逐句稿/候选/检测统计/导出)。
 * 原先这些活在 App.tsx 与 HighlightsView 的 useState 里——回退一步候选就全丢,
 * 重新检测又是一轮 LLM 花费。进 store 后视图随便切,结果一直在。
 *
 * 可恢复字段由主进程按源文件指纹原子保存;进行中任务和弹层等瞬态不恢复。
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
  SessionCheckpoint,
  SessionEditCommand,
  SessionEditHistory,
} from "../../../shared/api-types";
import { appendSessionEdit, compactSessionEditHistory, emptySessionEditHistory } from "../../../shared/session-edit-history";

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
  /** Human edits only; AI/transcription setters establish a fresh baseline. */
  editHistory: SessionEditHistory;

  setFile: (file: ProbedFile | null) => void;
  setTranscript: (t: Transcript | null) => void;
  setAuto: (v: boolean) => void;
  setSettingsOpen: (v: boolean) => void;
  setCandidates: (c: HighlightCandidate[] | null) => void;
  patchCandidate: (id: number, patch: Partial<HighlightCandidate>) => void;
  addCandidate: (candidate: HighlightCandidate) => void;
  editTranscript: (transcript: Transcript) => void;
  setSelected: (ids: Set<number>) => void;
  toggleSelected: (id: number) => void;
  undoEdit: () => void;
  redoEdit: () => void;
  setFocusedId: (id: number | null) => void;
  setDetecting: (v: boolean) => void;
  setDetectError: (msg: string | null) => void;
  setStats: (s: DetectStats) => void;
  setDiarize: (v: boolean) => void;
  setReferencePath: (p: string | null) => void;
  markParamsDirty: (v: boolean) => void;
  setExporting: (v: { clips: HighlightCandidate[]; options: RenderToggles } | null) => void;
  /** 从已验证的磁盘检查点恢复稳定字段，并把所有瞬态重置为空闲。 */
  restore: (checkpoint: SessionCheckpoint) => void;
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
  editHistory: emptySessionEditHistory(),

  setFile: (file) => set({ file }),
  setTranscript: (transcript) => set({ transcript, editHistory: emptySessionEditHistory() }),
  setAuto: (auto) => set({ auto }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setCandidates: (candidates) => set({ candidates, editHistory: emptySessionEditHistory() }),
  patchCandidate: (id, patch) => {
    const state = get();
    const before = state.candidates?.find((candidate) => candidate.id === id);
    if (!before) return;
    const after = { ...before, ...patch };
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    set({
      candidates: (state.candidates ?? []).map((candidate) => (candidate.id === id ? after : candidate)),
      editHistory: appendSessionEdit(state.editHistory, { kind: "candidate-update", candidateId: id, before, after }),
    });
  },
  addCandidate: (candidate) => {
    const state = get();
    if (state.candidates?.some((item) => item.id === candidate.id)) return;
    const beforeSelected = [...state.selected];
    const afterSelected = [...new Set([...beforeSelected, candidate.id])];
    const command: SessionEditCommand = {
      kind: "candidate-add",
      candidate,
      beforeSelected,
      afterSelected,
      beforeFocusedId: state.focusedId,
      afterFocusedId: candidate.id,
    };
    set({
      candidates: [...(state.candidates ?? []), candidate].sort((a, b) => a.startSec - b.startSec),
      selected: new Set(afterSelected),
      focusedId: candidate.id,
      editHistory: appendSessionEdit(state.editHistory, command),
    });
  },
  editTranscript: (transcript) => {
    const state = get();
    if (!state.transcript) return;
    const previous = new Map(state.transcript.segments.map((segment) => [segment.id, segment]));
    const changes = transcript.segments.flatMap((after) => {
      const before = previous.get(after.id);
      return before && JSON.stringify(before) !== JSON.stringify(after) ? [{ segmentId: after.id, before, after }] : [];
    });
    if (changes.length === 0) return;
    set({ transcript, editHistory: appendSessionEdit(state.editHistory, { kind: "transcript-update", changes }) });
  },
  setSelected: (selected) => set({ selected }),
  toggleSelected: (id) => {
    const state = get();
    const next = new Set(state.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({
      selected: next,
      editHistory: appendSessionEdit(state.editHistory, { kind: "selection", before: [...state.selected], after: [...next] }),
    });
  },
  undoEdit: () => set((state) => replayHistory(state, "undo")),
  redoEdit: () => set((state) => replayHistory(state, "redo")),
  setFocusedId: (focusedId) => set({ focusedId }),
  setDetecting: (detecting) => set({ detecting }),
  setDetectError: (detectError) => set({ detectError }),
  setStats: (stats) => set({ stats }),
  setDiarize: (diarize) => set({ diarize }),
  setReferencePath: (referencePath) => set({ referencePath }),
  markParamsDirty: (paramsDirty) => set({ paramsDirty }),
  setExporting: (exporting) => set({ exporting }),
  restore: (checkpoint) => {
    const ids = new Set((checkpoint.candidates ?? []).map((candidate) => candidate.id));
    set({
      file: checkpoint.file,
      transcript: checkpoint.transcript,
      auto: false,
      settingsOpen: false,
      candidates: checkpoint.candidates,
      selected: new Set(checkpoint.selected.filter((id) => ids.has(id))),
      focusedId: checkpoint.focusedId !== null && ids.has(checkpoint.focusedId) ? checkpoint.focusedId : null,
      detecting: false,
      detectError: null,
      stats: checkpoint.stats,
      diarize: checkpoint.diarize,
      referencePath: checkpoint.referencePath,
      paramsDirty: checkpoint.paramsDirty,
      exporting: null,
      editHistory: checkpoint.editHistory ? compactSessionEditHistory(checkpoint.editHistory) : emptySessionEditHistory(),
    });
  },
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
      editHistory: emptySessionEditHistory(),
    }),
}));

type ReplayableState = Pick<SessionState, "candidates" | "selected" | "focusedId" | "transcript" | "editHistory">;

function selectionForCandidates(ids: number[], candidates: HighlightCandidate[] | null): Set<number> {
  const live = new Set((candidates ?? []).map((candidate) => candidate.id));
  return new Set(ids.filter((id) => live.has(id)));
}

function applyEditCommand(state: ReplayableState, command: SessionEditCommand, direction: "undo" | "redo"): Partial<ReplayableState> {
  const previous = direction === "undo";
  if (command.kind === "selection") {
    return { selected: selectionForCandidates(previous ? command.before : command.after, state.candidates) };
  }
  if (command.kind === "candidate-update") {
    const candidate = previous ? command.before : command.after;
    return { candidates: (state.candidates ?? []).map((item) => (item.id === command.candidateId ? candidate : item)) };
  }
  if (command.kind === "candidate-add") {
    if (previous) {
      const candidates = (state.candidates ?? []).filter((item) => item.id !== command.candidate.id);
      return {
        candidates,
        selected: selectionForCandidates(command.beforeSelected, candidates),
        focusedId: command.beforeFocusedId,
      };
    }
    const candidates = [...(state.candidates ?? []).filter((item) => item.id !== command.candidate.id), command.candidate].sort((a, b) => a.startSec - b.startSec);
    return {
      candidates,
      selected: selectionForCandidates(command.afterSelected, candidates),
      focusedId: command.afterFocusedId,
    };
  }
  if (!state.transcript) return {};
  const replacements = new Map(command.changes.map((change) => [change.segmentId, previous ? change.before : change.after]));
  return {
    transcript: {
      ...state.transcript,
      segments: state.transcript.segments.map((segment) => replacements.get(segment.id) ?? segment),
    },
  };
}

function replayHistory(state: SessionState, direction: "undo" | "redo"): Partial<SessionState> {
  const source = direction === "undo" ? state.editHistory.undo : state.editHistory.redo;
  const command = source[source.length - 1];
  if (!command) return {};
  const undo = state.editHistory.undo.slice();
  const redo = state.editHistory.redo.slice();
  if (direction === "undo") {
    undo.pop();
    redo.push(command);
  } else {
    redo.pop();
    undo.push(command);
  }
  return { ...applyEditCommand(state, command, direction), editHistory: compactSessionEditHistory({ undo, redo }) };
}

/** Project the Zustand state onto the stable, JSON-safe persistence contract. */
export function sessionCheckpointFromState(state: SessionState = useSession.getState()): SessionCheckpoint | null {
  if (!state.file) return null;
  return {
    file: state.file,
    transcript: state.transcript,
    candidates: state.candidates,
    selected: [...state.selected],
    focusedId: state.focusedId,
    stats: state.stats,
    diarize: state.diarize,
    referencePath: state.referencePath,
    paramsDirty: state.paramsDirty,
    ...(state.editHistory.undo.length + state.editHistory.redo.length > 0 ? { editHistory: state.editHistory } : {}),
    savedAt: new Date().toISOString(),
  };
}

/** Build the first stable document for a freshly probed source before it enters the live store. */
export function initialSessionCheckpoint(file: ProbedFile): SessionCheckpoint {
  return {
    file,
    transcript: null,
    candidates: null,
    selected: [],
    focusedId: null,
    stats: EMPTY_STATS,
    diarize: false,
    referencePath: null,
    paramsDirty: false,
    savedAt: new Date().toISOString(),
  };
}
