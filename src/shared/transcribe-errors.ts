/**
 * 转写失败的错误归因协议(issue #2)。
 * 曾经所有失败都显示「请确认文件包含音轨」,用户被误导去反复转码——
 * 真实原因(模型下载失败/解压失败/真没音轨)必须区分开并透传到 UI。
 * 主进程在 IPC 边界打标记,渲染层解析标记选文案;标记跨 IPC 只能靠
 * message 字符串携带,所以用稳定的前缀 token 而不是 Error 子类。
 */

/** 素材经探测确认没有音轨——用户换素材才能解决。 */
export const ERR_TAG_NO_AUDIO = "[hotclip:no-audio]";
/** 模型下载/解压失败——检查网络或磁盘,与素材无关。 */
export const ERR_TAG_MODEL_DOWNLOAD = "[hotclip:model-download]";
/** 模型已在却加载失败——最常见是 Windows 中文路径原生层打不开(issue #4),其次是模型文件损坏。 */
export const ERR_TAG_MODEL_LOAD = "[hotclip:model-load]";

export type TranscribeErrorKind = "no-audio" | "model-download" | "model-load" | "generic";

/**
 * 主进程侧:根据失败后的补充探测结果给原始错误打标记。
 * 探测不到(probe 也失败)时保持原样——宁可笼统,不可错怪素材。
 */
export function tagTranscribeError(rawMessage: string, media: { hasAudio: boolean } | null): string {
  if (media && !media.hasAudio) return `${ERR_TAG_NO_AUDIO} ${rawMessage}`;
  if (/model download failed/i.test(rawMessage)) return `${ERR_TAG_MODEL_DOWNLOAD} ${rawMessage}`;
  // sherpa 原生层创建 recognizer 失败的固定文案——模型文件打不开/损坏,与素材无关
  if (/check your config/i.test(rawMessage)) return `${ERR_TAG_MODEL_LOAD} ${rawMessage}`;
  return rawMessage;
}

/**
 * 渲染层侧:从 IPC 送回的错误文本里剥掉 Electron 的包装前缀
 * ("Error invoking remote method 'x': Error: ..."),识别标记归类,
 * 并留下可展示给用户的原始细节(报 issue 时贴出来才有诊断价值)。
 */
export function parseTranscribeError(raw: string): { kind: TranscribeErrorKind; detail: string } {
  let detail = raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, "").trim();
  let kind: TranscribeErrorKind = "generic";
  if (detail.includes(ERR_TAG_NO_AUDIO)) {
    kind = "no-audio";
    detail = detail.replace(ERR_TAG_NO_AUDIO, "").trim();
  } else if (detail.includes(ERR_TAG_MODEL_DOWNLOAD)) {
    kind = "model-download";
    detail = detail.replace(ERR_TAG_MODEL_DOWNLOAD, "").trim();
  } else if (detail.includes(ERR_TAG_MODEL_LOAD)) {
    kind = "model-load";
    detail = detail.replace(ERR_TAG_MODEL_LOAD, "").trim();
  }
  return { kind, detail };
}
