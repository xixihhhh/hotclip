/**
 * 变形度评分(v0.14):切片相对源直播画面「改了多少」的量化。
 *
 * 为什么要有它:2026 年平台把「变形量」当硬性生存指标——Reels 用视觉指纹
 * 检测「保留他人原始视听元素 ≥70%」判搬运(30 天 10 条转载整号移出推荐)、
 * YouTube「Inauthentic Content」打量产回收、抖音判原创看「信息熵变化/表达
 * 主体性」。变形不够的切片不是「不够美」,是「发不出去」。
 *
 * 口径:各变形项按对「视觉指纹/信息熵改变」的贡献计权,总分封顶 100。
 * 权重是方向性启发(平台不公开阈值),用途是**相对提醒**——低于警戒线亮
 * 黄牌并告诉用户开哪几个开关能补,不做「过审保证」承诺。
 * 纯函数,渲染层(出片面板实时预估)与导出侧(clips.json 回执)共用;
 * 本文件不得引入任何 Node 依赖。
 */

/** 参与打分的变形项(渲染层用开关预估,导出侧用真实回执)。 */
export interface TransformInputs {
  /** 竖屏重构(9:16 重裁改变构图,变形贡献最大)。 */
  vertical: boolean;
  /** 字幕烧录(叠加信息层)。 */
  captions: boolean;
  /** 跳剪/口头禅/剪重录任一生效(时间轴重构)。 */
  recut: boolean;
  /** 开场重构(高潮前置或爆点闪现,叙事顺序改变)。 */
  reopened: boolean;
  /** 标题贴片或开场钩子大字。 */
  titleOverlay: boolean;
  /** 自动运镜(画面运动轨迹改变)。 */
  autoZoom: boolean;
  /** BGM 混入(重做音频环境——原创判定明确认可项)。 */
  bgm: boolean;
  /** 音效打点。 */
  sfx: boolean;
  /** 多片段拼接(≥2 段,叙事重构)。 */
  stitched: boolean;
  /** 双语字幕(翻译信息层)。 */
  translated: boolean;
  /** 水印/品牌层。 */
  watermark: boolean;
}

/** 各项权重(合计可超 100,得分封顶;注释即依据)。 */
export const TRANSFORM_WEIGHTS: Array<{ key: keyof TransformInputs; weight: number }> = [
  { key: "vertical", weight: 26 }, // 画幅与构图整体改变,视觉指纹差异最大来源
  { key: "captions", weight: 20 }, // 全程叠加的信息层
  { key: "recut", weight: 15 }, // 时间轴重构(跳剪/口头禅/重录)
  { key: "reopened", weight: 10 }, // 叙事顺序重排(高潮前置/爆点闪现)
  { key: "titleOverlay", weight: 8 }, // 标题贴片/开场钩子大字
  { key: "autoZoom", weight: 7 }, // 画面运动改变
  { key: "bgm", weight: 6 }, // 重做音频环境(原创判定认可项)
  { key: "stitched", weight: 6 }, // 多段拼接 = 叙事重构
  { key: "sfx", weight: 3 },
  { key: "translated", weight: 3 },
  { key: "watermark", weight: 2 },
];

/** 警戒线:低于此分接近「裁一刀直接发」,搬运判定风险高。 */
export const TRANSFORM_WARN_BELOW = 40;

export interface TransformScore {
  /** 0-100。 */
  score: number;
  /** warn = 低于警戒线,建议补变形项。 */
  level: "warn" | "ok" | "strong";
  /** 没开且权重最高的前几项(给用户的「开哪个能补分」提示)。 */
  missingTop: Array<keyof TransformInputs>;
}

/** 计分(纯函数):命中项加权求和,封顶 100;≥70 算 strong。 */
export function transformScore(inputs: TransformInputs): TransformScore {
  let score = 0;
  const missing: Array<{ key: keyof TransformInputs; weight: number }> = [];
  for (const { key, weight } of TRANSFORM_WEIGHTS) {
    if (inputs[key]) score += weight;
    else missing.push({ key, weight });
  }
  score = Math.min(100, score);
  return {
    score,
    level: score < TRANSFORM_WARN_BELOW ? "warn" : score >= 70 ? "strong" : "ok",
    missingTop: missing
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 3)
      .map((m) => m.key),
  };
}
