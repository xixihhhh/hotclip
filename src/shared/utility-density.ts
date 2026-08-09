/**
 * 实用密度信号(v0.14 第十路):候选文本里「值得收藏」的信息浓度。
 *
 * 依据:2026 抖音算法收藏率权重据多方口径超 40%、慢推流 7 天长效评估看
 * 收藏与回搜;TikTok 搜索价值计入创作者奖励 RPM。「有用/可收藏/可搜索」
 * 是与「精彩」不同的维度——步骤、清单、具体数字、方法论命中的片段,
 * 观众会长按收藏、事后回搜,这类内容此前在「爆点优先」的目标函数里吃亏。
 *
 * 纯启发式文本统计,零模型零成本;分数只做「小幅加分 + 打标 + 文案导向」,
 * 不推翻爆点排序(信息密度是加分项不是替代项)。纯函数,无 Node 依赖。
 */

/** 步骤/顺序引导词(中英)。 */
const STEP_RE = /第[一二三四五六七八九十\d]+步|首先|其次|然后|接下来|接着|最后一步|step\s*\d|first,|second,|finally/gi;
/** 清单/盘点结构(「三个方法」「5 个坑」)。 */
const LIST_RE = /[一二三四五六七八九十\d]+\s*(?:个|种|条|点|大|招)\s*(?:方法|技巧|误区|坑|建议|习惯|细节|步骤|原则|信号|问题|tips?)/gi;
/** 方法论/干货词。 */
const METHOD_RE = /方法|技巧|公式|口诀|配方|做法|教程|攻略|避坑|误区|秘诀|清单|checklist|recipe|formula|how to/gi;
/** 具体数字(价格/比例/参数——≥2 位才算,单个数字噪声太大)。 */
const NUMBER_RE = /\d{2,}[%％折万亿元块]?|\d+\.\d+/g;

export interface UtilityDensity {
  /** 0-10:实用密度分。 */
  score: number;
  /** 命中的证据词(去重,给人看的解释)。 */
  hits: string[];
}

/** 判定为「值得收藏」的分数线。 */
export const UTILITY_SAVE_WORTHY = 4;
/** 回流选段排序的加分上限(小幅:密度是加分项不是替代项)。 */
export const UTILITY_BOOST_MAX = 6;

/** 文本 → 实用密度(纯函数)。 */
export function utilityDensity(text: string): UtilityDensity {
  if (!text) return { score: 0, hits: [] };
  const hits: string[] = [];
  const seen = new Set<string>();
  const collect = (re: RegExp, cap: number): number => {
    const found = text.match(re) ?? [];
    let fresh = 0;
    for (const f of found) {
      const key = f.toLowerCase().trim();
      if (seen.has(key)) continue;
      seen.add(key);
      if (hits.length < 8) hits.push(f.trim());
      fresh++;
    }
    return Math.min(cap, fresh);
  };
  // 结构性证据(步骤/清单)权重高;方法论词与数字封顶防灌水
  const score =
    collect(STEP_RE, 3) * 2 + collect(LIST_RE, 2) * 3 + collect(METHOD_RE, 3) + collect(NUMBER_RE, 3);
  return { score: Math.min(10, score), hits };
}

/** 排序加分:达线后每分 +2,封顶 UTILITY_BOOST_MAX。 */
export function utilityBoost(score: number): number {
  if (score < UTILITY_SAVE_WORTHY) return 0;
  return Math.min(UTILITY_BOOST_MAX, (score - UTILITY_SAVE_WORTHY + 1) * 2);
}
