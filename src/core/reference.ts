/**
 * 参考视频驱动(借鉴 OpenMontage 的 reference-driven 创作):用户丢进一条
 * 想对标的爆款切片,本地实测它的节奏——时长/语速/句长/镜头切换频率/开场
 * 钩子——生成「风格画像」,注入找爆点提示词,让选段向对标的节奏靠拢。
 * 画像是偏好不是硬约束:优质内容仍以爆点潜质为先,避免为凑节奏选废片。
 *
 * 本模块只有纯函数(画像计算/提示词段落),可单测;转写与镜头检测由
 * pipeline 层复用现有设施(transcribeCached / detectShotBoundaries)后把
 * 结果喂进来——素材照旧不出电脑。
 */
import type { Transcript } from "../shared/api-types";

/** 参考爆款的风格画像(全部来自实测,不猜)。 */
export interface ReferenceProfile {
  /** 参考片时长(秒)。 */
  durationSec: number;
  /** 语速:中文按字/秒,英文按词/秒。 */
  speechRate: number;
  /** 平均句长(中文字/英文词)。 */
  avgSentenceLen: number;
  /** 镜头切换频率(次/分钟);检测失败或纯音频为 null。 */
  cutsPerMin: number | null;
  /** 开场钩子句(第一句原文,截断保底)。 */
  hookLine: string;
  /** 参考片逐句稿是否中文(决定单位口径)。 */
  zh: boolean;
}

const CJK_RE = /[一-鿿]/;

/** 中文按字、英文按词的口径判断(与 highlight 的判定同思路,独立实现防环依赖)。 */
function isChinese(transcript: Transcript): boolean {
  const lang = transcript.language.toLowerCase();
  if (lang.startsWith("zh") || lang.startsWith("yue")) return true;
  if (lang && lang !== "auto") return false;
  const sample = transcript.segments.slice(0, 10).map((s) => s.text).join("");
  const cjk = (sample.match(/[一-鿿]/g) ?? []).length;
  return sample.length > 0 && cjk / sample.length > 0.3;
}

/** 一段文本的计数单位:中文数 CJK 字,英文数空白分隔的词。 */
function countUnits(text: string, zh: boolean): number {
  if (zh) {
    let n = 0;
    for (const ch of text) if (CJK_RE.test(ch)) n++;
    return n;
  }
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * 从参考片逐句稿 + 镜头边界实测风格画像(纯函数)。
 * 语速用「说话时段」而不是全片时长——参考片若有留白,语速不该被稀释。
 */
export function buildReferenceProfile(transcript: Transcript, shotBoundaries: number[] | null): ReferenceProfile {
  const zh = isChinese(transcript);
  const segs = transcript.segments;
  const durationSec =
    transcript.durationSec > 0 ? transcript.durationSec : segs.length > 0 ? segs[segs.length - 1].endSec : 0;
  const units = segs.reduce((a, s) => a + countUnits(s.text, zh), 0);
  const speakingSec = segs.reduce((a, s) => a + Math.max(0, s.endSec - s.startSec), 0);
  const speechRate = speakingSec > 0 ? Number((units / speakingSec).toFixed(1)) : 0;
  const avgSentenceLen = segs.length > 0 ? Math.round(units / segs.length) : 0;
  const cutsPerMin =
    shotBoundaries !== null && durationSec > 3
      ? Number((shotBoundaries.length / (durationSec / 60)).toFixed(1))
      : null;
  return {
    durationSec: Number(durationSec.toFixed(1)),
    speechRate,
    avgSentenceLen,
    cutsPerMin,
    hookLine: (segs[0]?.text ?? "").trim().slice(0, 50),
    zh,
  };
}

/**
 * 画像 → 找爆点 system prompt 的追加段落(纯函数)。zh 取主素材逐句稿的
 * 语言(提示词整体语言),画像单位口径跟参考片自己(profile.zh)。
 */
export function referencePromptSection(profile: ReferenceProfile, zh: boolean): string {
  const lo = Math.round(profile.durationSec * 0.7);
  const hi = Math.round(profile.durationSec * 1.3);
  const unit = profile.zh ? (zh ? "字" : "chars") : (zh ? "词" : "words");
  if (zh) {
    const facts = [
      `时长 ${Math.round(profile.durationSec)} 秒`,
      `语速 ${profile.speechRate} ${unit}/秒`,
      `平均句长 ${profile.avgSentenceLen} ${unit}`,
      ...(profile.cutsPerMin !== null ? [`镜头切换 ${profile.cutsPerMin} 次/分钟`] : []),
      ...(profile.hookLine ? [`开场钩子「${profile.hookLine}」`] : []),
    ].join("、");
    return (
      `\n\n【参考爆款画像】用户提供了一条想对标的爆款切片,实测:${facts}。` +
      `选段时向这个节奏靠拢:优先选目标时长 ${lo}~${hi} 秒、语速与信息密度相近、开场钩子形态类似(同为提问/冲突/悬念式)的片段;` +
      `这是偏好不是硬约束——内容本身的爆点潜质永远优先,不要为凑节奏选平庸段落。`
    );
  }
  const facts = [
    `duration ${Math.round(profile.durationSec)}s`,
    `speech rate ${profile.speechRate} ${unit}/s`,
    `avg sentence ${profile.avgSentenceLen} ${unit}`,
    ...(profile.cutsPerMin !== null ? [`${profile.cutsPerMin} shot cuts/min`] : []),
    ...(profile.hookLine ? [`opening hook "${profile.hookLine}"`] : []),
  ].join(", ");
  return (
    `\n\n[Reference clip profile] The user supplied a viral clip to model after — measured: ${facts}. ` +
    `Lean toward its rhythm: prefer candidates of ${lo}–${hi}s with similar pacing/density and a similar hook shape (question/conflict/suspense). ` +
    `This is a preference, not a hard rule — genuine viral potential always wins; never pick mediocre segments just to match the rhythm.`
  );
}
