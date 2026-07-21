/**
 * 平台违禁词 lint(本地规则,零 API):对每条切片的「对外发布物料」——
 * 标题/钩子/发布文案/字幕文本——做一遍平台风险词扫描,命中并入出片质检
 * (clips.json 的 qa 字段)。定位是「发布前风险提示」,不是审查:告诉创作者
 * 哪条片的哪句话在抖音/小红书/视频号大概率限流或被打回,最终取舍在人。
 *
 * 规则参考《广告法》绝对化用语、医疗/功效宣称红线与各平台社区规范的公开
 * 高频雷词(带货场景优先)。全部纯函数可单测;规则表就是数据,加词改词
 * 不动逻辑。
 */

/** 命中来源:哪份物料撞的词。 */
export type LintSource = "title" | "hook" | "publish" | "caption";

/** 一次违禁词命中。 */
export interface LintHit {
  /** 命中的原文词(规则实际匹配到的文本)。 */
  term: string;
  /** 风险类别(人类可读,直接进告警文案)。 */
  category: string;
  source: LintSource;
}

/** 一组规则:同类别的高频雷词合并成一条正则(全局匹配)。 */
interface LintRuleSet {
  category: string;
  re: RegExp;
}

/**
 * 平台风险词规则表(带货文案高危词优先)。注意控制误报:一律用完整词组,
 * 不用裸「最/第一」这类会扫到日常口语的短模式。
 */
const LINT_RULES: LintRuleSet[] = [
  {
    // 《广告法》第九条绝对化用语:一处命中就够平台打回一次
    category: "绝对化用语",
    re: /全网最低价?|全网最[便好优强]\S?|史上最\S|历史最低|最低价|最便宜|最优惠|最划算|最有效|最先进|最高级|最顶级|最正宗|销量第一|全国第一|全球第一|世界第一|行业第一|排名第一|全网第一|第一品牌|国家级|世界级|顶级|极品|绝无仅有|独一无二|空前绝后|无与伦比|首选|别无分店|仅此一家/g,
  },
  {
    // 普通食品/化妆品/日用品宣称医疗功效是各平台硬红线
    category: "医疗功效宣称",
    re: /治疗|治愈|根治|痊愈|药到病除|消炎|杀菌|抑菌|抗菌|抗病毒|抗癌|防癌|抗肿瘤|降血压|降血糖|降血脂|降三高|降尿酸|排毒|清宿便|减肥|瘦身|燃脂|溶脂|瘦脸|美白|祛斑|淡斑|祛痘|去皱|抗衰|生发|防脱|固发|壮阳|补肾|养胃|护肝|安神助眠|提高免疫力|增强免疫|调理内分泌|疏通经络|活血化瘀|无副作用|无依赖/g,
  },
  {
    // 功效担保式承诺:退款/赔付/见效期限都属可验证承诺,做不到即虚假宣传
    category: "夸大承诺",
    re: /无效退款|无效全额退|假一赔[十百万]|百分之?百正品|百分之?百有效|100%正品|100%有效|包治|包好|包过|包会|保证见效|保证效果|保证治愈|当天见效|三天见效|七天见效|立竿见影|一次见效|永不反弹|永不复发|彻底根除/g,
  },
  {
    // 收益承诺:金融/副业/知识付费类带货的重灾区
    category: "收益承诺",
    re: /稳赚不?赔?|保本保息|保本|躺赚|躺着赚钱|睡后收入|一夜暴富|暴富|月入过万|月入\d+万?|日入过千|日入\d+|周入\d+|无风险高?收益|稳定收益|包赚|包盈利|财务自由|轻松月入|零风险/g,
  },
  {
    // 价格/稀缺误导:虚构紧迫感与价格锚点
    category: "价格误导",
    re: /地板价|跳楼价|骨折价|白菜价|亏本清仓|亏本甩卖|亏本价|清仓价|出厂价直销|秒杀全网|全网秒杀|仅此一天|最后一天|错过再无|错过不再|今天不买再等一年/g,
  },
  {
    // 站外导流/诱导:抖音/小红书/视频号都会限流甚至封号的引流话术
    category: "站外导流",
    re: /加微信|加我微信|微信号|威信|薇信|[vV]信|[vV][xX]号|扣扣号?|QQ群|加群领|私信我领|私信领取|评论区扣[1一]|点击链接|主页链接购买|淘宝搜索|某宝|某东|某音|某书|领红包|现金红包|关注抽奖/g,
  },
  {
    // 权威背书:已废止的认证与不可证实的推荐
    category: "权威背书",
    re: /国家免检|国家认证|质检总局|药监局认证|药监局推荐|专家一致推荐|医生推荐|央视推荐|人民日报推荐|驰名商标|中国名牌|军工品质|国家特供|特供|专供/g,
  },
  {
    // 迷信/博彩擦边:玄学带货与"稳赢"话术
    category: "迷信博彩",
    re: /开光|转运|辟邪|消灾|改运|招财转运|稳赢|包中奖?|内部渠道|内幕消息|必中/g,
  },
];

/** 扫一段文本,返回去重后的命中(同一词多次出现只报一次)。 */
export function lintText(text: string): Array<{ term: string; category: string }> {
  const out: Array<{ term: string; category: string }> = [];
  if (!text) return out;
  const seen = new Set<string>();
  for (const rule of LINT_RULES) {
    rule.re.lastIndex = 0;
    for (let m = rule.re.exec(text); m; m = rule.re.exec(text)) {
      const term = m[0];
      if (!seen.has(term)) {
        seen.add(term);
        out.push({ term, category: rule.category });
      }
      // 全局正则防空匹配死循环(规则都非空,防御性保底)
      if (m.index === rule.re.lastIndex) rule.re.lastIndex++;
    }
  }
  return out;
}

/** 单条切片的待扫物料(全部可缺省;缺省项跳过)。 */
export interface ClipLintInput {
  title?: string;
  /** 钩子 + 悬念句(开场大字/文案素材,拼一起扫)。 */
  hook?: string;
  publish?: { title: string; hashtags: string[]; description: string; cta?: string } | null;
  /** 字幕文本(逐词 text 直接拼接;中文按字出词,必须无缝拼才扫得到跨词命中)。 */
  captionText?: string;
}

/**
 * 扫一条切片的全部发布物料 → 命中清单。同一词在不同物料各报一次
 * (标题里的「最低价」和字幕里的「最低价」要分别改),同物料内去重。
 */
export function lintClipContent(input: ClipLintInput): LintHit[] {
  const sources: Array<[LintSource, string | undefined]> = [
    ["title", input.title],
    ["hook", input.hook],
    [
      "publish",
      input.publish
        ? [input.publish.title, input.publish.hashtags.join(" "), input.publish.description, input.publish.cta ?? ""].join("\n")
        : undefined,
    ],
    ["caption", input.captionText],
  ];
  const hits: LintHit[] = [];
  for (const [source, text] of sources) {
    if (!text) continue;
    for (const h of lintText(text)) hits.push({ ...h, source });
  }
  return hits;
}

const SOURCE_LABEL: Record<LintSource, string> = {
  title: "标题",
  hook: "钩子",
  publish: "文案",
  caption: "字幕",
};

/** 告警文案里最多点名几个词(其余归入「等 N 个」,完整清单在 contentHits)。 */
const ISSUE_MAX_TERMS = 5;

/** 命中清单 → 一条人类可读告警;无命中返回 null。 */
export function formatLintIssue(hits: LintHit[]): string | null {
  if (hits.length === 0) return null;
  const shown = hits
    .slice(0, ISSUE_MAX_TERMS)
    .map((h) => `「${h.term}」(${h.category}·${SOURCE_LABEL[h.source]})`)
    .join("、");
  const more = hits.length > ISSUE_MAX_TERMS ? `等 ${hits.length} 处` : "";
  return `发布物料命中平台风险词:${shown}${more}(发布前请按平台规则核对)`;
}
