/**
 * 转写失败归因协议(issue #2):主进程打标记、渲染层解析必须严格互逆——
 * 标记跨 IPC 只靠 message 字符串携带,两侧一旦对不上,用户又会回到
 * 「所有失败都提示确认音轨」的误导状态。
 */
import { describe, expect, it } from "vitest";
import {
  ERR_TAG_MODEL_DOWNLOAD,
  ERR_TAG_MODEL_LOAD,
  ERR_TAG_NO_AUDIO,
  parseTranscribeError,
  tagTranscribeError,
} from "../../shared/transcribe-errors";

describe("tagTranscribeError", () => {
  it("素材确认无音轨 → 打 no-audio 标记(即便错误文本像别的失败)", () => {
    const tagged = tagTranscribeError("ffmpeg exited with code 1", { hasAudio: false });
    expect(tagged.startsWith(ERR_TAG_NO_AUDIO)).toBe(true);
    expect(tagged).toContain("ffmpeg exited with code 1");
  });

  it("有音轨但模型下载失败 → 打 model-download 标记", () => {
    const raw = "model download failed after all mirrors (sensevoice-2024-07-17): HTTP 403";
    const tagged = tagTranscribeError(raw, { hasAudio: true });
    expect(tagged.startsWith(ERR_TAG_MODEL_DOWNLOAD)).toBe(true);
    expect(tagged).toContain(raw);
  });

  it("probe 也失败(media 为 null)时不敢归因为无音轨,保持原样", () => {
    expect(tagTranscribeError("some decode error", null)).toBe("some decode error");
  });

  it("有音轨、非模型下载的失败保持原样", () => {
    expect(tagTranscribeError("boom", { hasAudio: true })).toBe("boom");
  });

  // issue #4:模型明明已装好,sherpa 创建 recognizer 失败(Windows 中文路径/
  // 模型损坏)只会抛这句固定文案——必须归因成 model-load,不能落回笼统提示
  it("sherpa 拒绝配置(模型打不开) → 打 model-load 标记", () => {
    const tagged = tagTranscribeError("Please check your config!", { hasAudio: true });
    expect(tagged.startsWith(ERR_TAG_MODEL_LOAD)).toBe(true);
    expect(tagged).toContain("Please check your config!");
  });

  it("素材确认无音轨优先于 model-load 归因", () => {
    const tagged = tagTranscribeError("Please check your config!", { hasAudio: false });
    expect(tagged.startsWith(ERR_TAG_NO_AUDIO)).toBe(true);
  });
});

describe("parseTranscribeError", () => {
  it("剥掉 Electron IPC 包装前缀,识别 no-audio 标记", () => {
    const raw = `Error invoking remote method 'hotclip:transcribe': Error: ${ERR_TAG_NO_AUDIO} ffmpeg exited with code 1`;
    expect(parseTranscribeError(raw)).toEqual({ kind: "no-audio", detail: "ffmpeg exited with code 1" });
  });

  it("识别 model-download 标记并保留细节", () => {
    const raw = `Error invoking remote method 'hotclip:transcribe': Error: ${ERR_TAG_MODEL_DOWNLOAD} model download failed after all mirrors (sensevoice): HTTP 403`;
    const parsed = parseTranscribeError(raw);
    expect(parsed.kind).toBe("model-download");
    expect(parsed.detail).toContain("HTTP 403");
  });

  it("无标记 → generic,细节为剥壳后的原始信息", () => {
    const raw = "Error invoking remote method 'hotclip:transcribe': Error: ENOSPC: no space left on device";
    expect(parseTranscribeError(raw)).toEqual({ kind: "generic", detail: "ENOSPC: no space left on device" });
  });

  it("非 IPC 包装的裸错误文本也能解析", () => {
    expect(parseTranscribeError("plain failure")).toEqual({ kind: "generic", detail: "plain failure" });
  });

  it("与 tagTranscribeError 互逆:标记往返后归因与细节都不丢", () => {
    const tagged = tagTranscribeError("ffmpeg exited with code 1", { hasAudio: false });
    const parsed = parseTranscribeError(`Error invoking remote method 'hotclip:transcribe': Error: ${tagged}`);
    expect(parsed).toEqual({ kind: "no-audio", detail: "ffmpeg exited with code 1" });
  });

  it("model-load 标记往返:归因正确且原始细节保留(报 issue 用)", () => {
    const tagged = tagTranscribeError("Please check your config!", { hasAudio: true });
    const parsed = parseTranscribeError(`Error invoking remote method 'hotclip:transcribe': Error: ${tagged}`);
    expect(parsed).toEqual({ kind: "model-load", detail: "Please check your config!" });
  });
});
