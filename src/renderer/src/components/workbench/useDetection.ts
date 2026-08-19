/**
 * 检测编排:把「调 detectHighlights → 结果落 session store」收成一个动作。
 * 与旧版最大的区别:参数改动只标脏,唯一的触发点是显式调用 run()——
 * 「重新检测」按钮是花 LLM 钱的那只手,用户永远知道自己按了它。
 */
import { useCallback } from "react";
import { getApi } from "../../api/provider";
import { useSession } from "../../stores/session-store";
import { useLlmStore } from "../../stores/llm-store";
import { useRenderPrefs } from "../../stores/render-prefs-store";
import { stripIpcError } from "../../../../shared/transcribe-errors";

export function useDetection(): { run: () => Promise<void> } {
  const { config, prefilter, vision } = useLlmStore();
  const { prefs } = useRenderPrefs();

  const run = useCallback(async (): Promise<void> => {
    const s = useSession.getState();
    if (!s.transcript || s.detecting) return;
    s.setDetecting(true);
    s.setDetectError(null);
    try {
      const focus = prefs.briefFocus.trim();
      const exclude = prefs.briefExclude.trim();
      const result = await getApi().detectHighlights(
        s.transcript,
        config,
        s.file?.path,
        s.diarize,
        prefilter.enabled ? { baseUrl: prefilter.baseUrl, model: prefilter.model } : null,
        vision.enabled ? { baseUrl: vision.baseUrl, model: vision.model, apiKey: vision.apiKey || undefined } : null,
        prefs.clipLength,
        prefs.products,
        s.referencePath,
        { id: prefs.genreId, custom: prefs.genreCustom },
        focus || exclude ? { focus: focus || undefined, exclude: exclude || undefined } : null,
        prefs.fullScan && vision.enabled
      );
      const st = useSession.getState();
      st.setCandidates(result.candidates);
      st.setStats({
        funnel: result.funnel ?? null,
        vision: result.vision ?? null,
        emotion: result.emotion ?? null,
        danmaku: result.danmaku ?? null,
        voice: result.voice ?? null,
        reference: result.reference ?? null,
        referenceError: result.referenceError ?? null,
      });
      // 复评通过的预选出片;右栏聚焦第一条推荐(没有就第一条)
      st.setSelected(new Set(result.candidates.filter((c) => c.recommended).map((c) => c.id)));
      st.setFocusedId(result.candidates.find((c) => c.recommended)?.id ?? result.candidates[0]?.id ?? null);
      // 带说话人标注的逐句稿回流(导出按说话人给字幕上色)
      if (result.transcript) st.setTranscript(result.transcript);
      st.markParamsDirty(false);
    } catch (e) {
      // IPC 包装串只会淹没真正有用的那句话——先剥壳再展示(issue #6)
      useSession.getState().setDetectError(stripIpcError(e instanceof Error ? e.message : String(e)));
    } finally {
      useSession.getState().setDetecting(false);
    }
  }, [config, prefilter, vision, prefs]);

  return { run };
}
