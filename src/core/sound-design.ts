/**
 * 声音设计(音效打点 + BGM 闪避):成片包装的声音层。
 *
 * 2026 调研结论(docs/RESEARCH-2026-08-CLIP-QUALITY.md 第二、三节):
 *  - 「音效放在哪一帧」没有学术方案也没有成熟 API——规则引擎做好即是竞争力:
 *    whoosh 卡拼接硬切帧、ding 卡情绪峰值(笑点/观点落地)、pop 卡开场钩子上屏;
 *    每条成片 ≤3 个,音效之间留最小间距,多了立刻廉价。
 *  - BGM 必须低于人声 15-20dB 并对人声 sidechain 闪避,收尾淡出。
 *
 * 实现取向:
 *  - 音效用 ffmpeg 本地合成(噪声扫频/正弦衰减)——零素材文件、零许可证风险,
 *    用户想换真实音效包时替换同名 wav 即可(合成只在文件缺失时发生)。
 *  - 混音是成片后的独立后处理趟:视频流 `-c:v copy` 零画质损失,只重编音频,
 *    单段/跳剪/拼接/高潮前置所有出片路径统一覆盖,质检(qa)在其后照常复核。
 *
 * 除 ensureSfxAssets/applySoundDesign 外全部纯函数,可单测。
 */
import { stat, rename, rm } from "fs/promises";
import { join } from "path";
import { runFfmpeg, LOUDNORM_FILTER, LOUDNORM_OUT_RATE } from "./cut";

export type SfxType = "whoosh" | "pop" | "ding";

/** 一次音效打点(成片输出时间轴,秒)。 */
export interface SfxCue {
  type: SfxType;
  atSec: number;
}

/** 每条成片的音效上限——调研口径 3-5 个,取下限保守值,多了廉价。 */
export const SFX_MAX_PER_CLIP = 3;
/** 相邻音效最小间距(秒):贴着放会糊成一团。 */
export const SFX_MIN_SPACING_SEC = 1.5;
/** 音效离片尾的最小距离(秒):片尾一声突兀的音效像事故。 */
const SFX_TAIL_GUARD_SEC = 0.6;
/** 音效混入电平(相对合成素材满幅):压在人声之下、但转场瞬间可闻。 */
export const SFX_MIX_VOLUME = 0.4;

/** BGM 相对人声的基准衰减(dB)——调研口径 15-20dB,取中值。 */
export const BGM_GAIN_DB = -17;
/** BGM 收尾淡出时长(秒)。 */
export const BGM_TAIL_FADE_SEC = 1.2;

/**
 * 三类音效的 ffmpeg 合成配方(48k 单声道 wav):
 *  - whoosh:粉噪 + 带通 + 对称淡入淡出 ≈ 噪声扫过的「呼」声,卡硬切帧
 *  - pop:高频正弦快速衰减 ≈ 轻「啵」,卡文字/钩子上屏帧
 *  - ding:基频+两个泛音的钟形衰减 ≈ 「叮」,卡情绪峰/观点落地
 * 纯函数:只产参数,不执行。
 */
export function synthSfxArgs(type: SfxType, outPath: string): string[] {
  const recipes: Record<SfxType, string[]> = {
    whoosh: [
      "-f", "lavfi",
      "-i", "anoisesrc=color=pink:r=48000:d=0.5",
      "-af",
      "highpass=f=300,lowpass=f=2400," +
        "afade=t=in:st=0:d=0.28:curve=qsin,afade=t=out:st=0.28:d=0.22:curve=qsin,volume=0.9",
    ],
    pop: [
      "-f", "lavfi",
      "-i", "aevalsrc=0.9*sin(2*PI*820*t)*exp(-22*t)+0.3*sin(2*PI*1640*t)*exp(-30*t):s=48000:d=0.2",
    ],
    ding: [
      "-f", "lavfi",
      "-i",
      "aevalsrc=0.55*sin(2*PI*1318.5*t)*exp(-5*t)+0.28*sin(2*PI*2637*t)*exp(-7*t)+0.12*sin(2*PI*3951*t)*exp(-9*t):s=48000:d=0.8",
    ],
  };
  return ["-hide_banner", "-y", ...recipes[type], "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", outPath];
}

/** 打点规划的输入(全部为成片输出时间轴)。 */
export interface SfxPlanInput {
  durationSec: number;
  /** 结构性硬切缝:多片段拼接缝、高潮前置迷你片→正片的接缝。 */
  seamsSec?: number[];
  /** 开场钩子在场时的上屏时刻(通常 0 附近);null/缺省 = 没有钩子。 */
  hookAtSec?: number | null;
  /** 峰值事件时刻,按强度从高到低排列(ding 只取最高的那个)。 */
  peakEventsSec?: number[];
  /** 上限覆盖(默认 SFX_MAX_PER_CLIP)。 */
  maxCues?: number;
}

/**
 * 规划音效打点。优先级:拼接缝 whoosh(结构性,观众必然感知到跳变)>
 * 情绪峰 ding > 开场钩子 pop。逐个放入,违反最小间距/越界的直接丢弃——
 * 宁缺毋滥。纯函数。
 */
export function planSfxCues(input: SfxPlanInput): SfxCue[] {
  const max = Math.max(0, input.maxCues ?? SFX_MAX_PER_CLIP);
  if (max === 0 || !(input.durationSec > 1)) return [];
  const placed: SfxCue[] = [];
  const fits = (at: number): boolean =>
    at >= 0 &&
    at <= input.durationSec - SFX_TAIL_GUARD_SEC &&
    placed.every((c) => Math.abs(c.atSec - at) >= SFX_MIN_SPACING_SEC);
  const put = (type: SfxType, at: number): void => {
    if (placed.length < max && fits(at)) placed.push({ type, atSec: Number(at.toFixed(3)) });
  };

  // 结构缝按时间序放(同为 whoosh,先后无强弱之分)
  for (const s of [...(input.seamsSec ?? [])].sort((a, b) => a - b)) put("whoosh", s);
  // 情绪峰只取最高的一个——ding 多了就成了游戏音效
  const topPeak = input.peakEventsSec?.[0];
  if (topPeak !== undefined) put("ding", topPeak);
  // 开场钩子:上屏即「啵」一下;钩子在片头,靠 fits 的间距规则与 whoosh 相让
  if (input.hookAtSec !== null && input.hookAtSec !== undefined) put("pop", Math.max(0.03, input.hookAtSec));

  return placed.sort((a, b) => a.atSec - b.atSec);
}

/** 声音设计混音选项。 */
export interface SoundDesignOptions {
  /** 音效打点(可空;空数组 = 只混 BGM)。 */
  cues: SfxCue[];
  /** 音效 wav 所在目录(<type>.wav);cues 非空时必填。 */
  sfxDir?: string;
  /** BGM 文件路径(可选);循环铺满全片并对人声闪避。 */
  bgmPath?: string;
  /** 成片时长(秒)——BGM 截断与收尾淡出需要。 */
  durationSec: number;
  /** 出片开了响度标准化时,混音后再过一遍 loudnorm 保住 -14 LUFS。 */
  normalizeLoudness?: boolean;
}

/** 是否有活可干(纯函数;调用方据此决定跳过整个后处理趟)。 */
export function hasSoundDesignWork(o: Pick<SoundDesignOptions, "cues" | "bgmPath">): boolean {
  return o.cues.length > 0 || Boolean(o.bgmPath);
}

/**
 * 组装声音设计后处理的 ffmpeg 参数(纯函数):
 * 输入 0 = 成片,1..N = 各音效 wav,末路 = BGM(-stream_loop 循环)。
 * 人声 → (asplit 出闪避侧链) → 与 BGM(sidechaincompress)与各音效(adelay)
 * amix(normalize=0 保持既有电平)→ 可选 loudnorm → 视频流复制回容器。
 */
export function buildSoundDesignArgs(
  inPath: string,
  outPath: string,
  o: SoundDesignOptions
): string[] {
  if (!hasSoundDesignWork(o)) throw new Error("sound design called with nothing to do");
  if (o.cues.length > 0 && !o.sfxDir) throw new Error("sfx cues require sfxDir");
  const inputs: string[] = ["-i", inPath];
  const graph: string[] = [];
  const mixIns: string[] = [];
  let inputIdx = 1;

  // 人声:有 BGM 时分出一路做闪避侧链
  if (o.bgmPath) {
    graph.push("[0:a]asplit=2[voice][sc]");
    mixIns.push("[voice]");
  } else {
    mixIns.push("[0:a]");
  }

  // 音效:各自 adelay 到打点时刻(左右声道同延迟),统一混入电平
  for (const cue of o.cues) {
    const ms = Math.max(0, Math.round(cue.atSec * 1000));
    inputs.push("-i", join(o.sfxDir!, `${cue.type}.wav`));
    graph.push(`[${inputIdx}:a]adelay=${ms}|${ms},volume=${SFX_MIX_VOLUME}[s${inputIdx}]`);
    mixIns.push(`[s${inputIdx}]`);
    inputIdx++;
  }

  // BGM:无限循环读入 → 截到片长 → 基准衰减 → 对人声侧链闪避 → 收尾淡出
  if (o.bgmPath) {
    inputs.push("-stream_loop", "-1", "-i", o.bgmPath);
    const fadeStart = Math.max(0, o.durationSec - BGM_TAIL_FADE_SEC);
    graph.push(
      `[${inputIdx}:a]atrim=end=${o.durationSec.toFixed(3)},asetpts=PTS-STARTPTS,` +
        `volume=${BGM_GAIN_DB}dB[bgmv]`,
      // 闪避参数:人声一起就把 BGM 再压 ~10dB,松手 0.5s 缓升——「说话让路」
      `[bgmv][sc]sidechaincompress=threshold=0.015:ratio=8:attack=60:release=500[bgmduck]`,
      `[bgmduck]afade=t=out:st=${fadeStart.toFixed(3)}:d=${BGM_TAIL_FADE_SEC}[bgmout]`
    );
    mixIns.push("[bgmout]");
  }

  // duration=first:一切以人声(成片原音轨)长度为准,延迟越界的音效自然截掉
  const tail = o.normalizeLoudness ? `,${LOUDNORM_FILTER}` : ",alimiter=limit=0.98";
  graph.push(`${mixIns.join("")}amix=inputs=${mixIns.length}:duration=first:normalize=0${tail}[mix]`);

  return [
    "-hide_banner", "-y",
    ...inputs,
    "-filter_complex", graph.join(";"),
    "-map", "0:v?",
    "-c:v", "copy",
    "-map", "[mix]",
    ...(o.normalizeLoudness ? ["-ar", LOUDNORM_OUT_RATE] : []),
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    outPath,
  ];
}

/** 三类音效全集(ensureSfxAssets 逐个合成)。 */
export const SFX_TYPES: SfxType[] = ["whoosh", "pop", "ding"];

/**
 * 确保音效素材就位:目录里缺哪个合成哪个(用户放同名 wav 即可替换默认音)。
 * 返回目录路径原样透传,便于调用方链式使用。
 */
export async function ensureSfxAssets(dir: string, signal?: AbortSignal): Promise<string> {
  for (const type of SFX_TYPES) {
    const path = join(dir, `${type}.wav`);
    const exists = await stat(path).then((s) => s.size > 0, () => false);
    if (!exists) await runFfmpeg(synthSfxArgs(type, path), { signal });
  }
  return dir;
}

/**
 * 对一条成片执行声音设计:混到临时文件,成功才原子替换(rename),
 * 任一步失败抛出由调用方 fail-open——绝不让音效把片子拖垮。
 */
export async function applySoundDesign(
  clipPath: string,
  options: SoundDesignOptions,
  signal?: AbortSignal
): Promise<void> {
  const tmpPath = clipPath.replace(/\.mp4$/, ".sound.mp4");
  try {
    await runFfmpeg(buildSoundDesignArgs(clipPath, tmpPath, options), { signal });
    await rename(tmpPath, clipPath);
  } catch (e) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw e;
  }
}
