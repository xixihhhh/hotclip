/**
 * 平台发布规格表:每个平台的封面画幅、标题/话题/正文上限。
 * 「平台发布包」按这张表把同一批成片适配成各平台直接能发的齐套素材——
 * 小红书要 3:4 封面、B站要横版封面、抖音前 55 字决定列表展示……这些
 * 规格散落在各平台创作者后台,切片手每次都要翻;这里一次编码,处处复用。
 *
 * id 与 safe-zones.ts 的平台 id 对齐(审阅台遮罩选的平台,发布包里就有)。
 * 上限取值宁保守勿激进:标注「建议」的是运营共识值,不是平台硬限制。
 * 纯数据 + 纯函数,renderer 与 core 共用。
 */

export interface PlatformSpec {
  /** 平台 id(与 safe-zones.ts 对齐,进 manifest 与偏好存储,稳定不改)。 */
  id: string;
  name: { zh: string; en: string };
  /** 封面导出像素(宽×高),按平台推荐画幅。 */
  cover: { w: number; h: number };
  /** 发布标题字符上限(超出会被截断并在 manifest 标记)。 */
  titleMax: number;
  /** 话题标签数上限(平台规则或运营建议值)。 */
  tagsMax: number;
  /** 备注(进 manifest,提醒发布时的平台特性)。 */
  noteZh: string;
  /** AIGC 标注操作提示(开了 AIGC 标识时进发布文案与 manifest;2026-07 新规三次违规封号)。 */
  aigcNoteZh: string;
}

// 封面画幅依据(2026-08 核对):抖音/快手/TikTok/Reels 竖屏 9:16;
// 小红书首图推荐 3:4(1080×1440);B站视频封面推荐 16:10;视频号 feed
// 卡片约 6:7;Shorts 用 YouTube 缩略图 16:9(1280×720)。
export const PLATFORM_SPECS: PlatformSpec[] = [
  {
    id: "douyin",
    name: { zh: "抖音", en: "Douyin" },
    cover: { w: 1080, h: 1920 },
    // 标题与正文同一栏:前 55 字决定列表/搜索展示,截断线画在这
    titleMax: 55,
    tagsMax: 5, // 建议值:话题过多稀释权重
    noteZh: "标题与正文同栏,前55字决定列表展示;话题建议不超过5个",
    aigcNoteZh: "发布时勾选「内容由AI生成」声明;平台要求AI内容前5秒显著标注(成片左上角标识已烧入)",
  },
  {
    id: "kuaishou",
    name: { zh: "快手", en: "Kuaishou" },
    cover: { w: 1080, h: 1920 },
    titleMax: 50,
    tagsMax: 4, // 建议值
    noteZh: "描述区展示行数有限,钩子放最前;话题建议不超过4个",
    aigcNoteZh: "发布时勾选AIGC内容声明(平台强制要求,违规三次封号)",
  },
  {
    id: "bilibili",
    name: { zh: "B站", en: "Bilibili" },
    cover: { w: 1146, h: 717 }, // 官方推荐 16:10
    titleMax: 80,
    tagsMax: 10, // 平台硬上限
    noteZh: "封面16:10横版;竖屏成片可发story,横屏版在「横屏/」目录;标签上限10个",
    aigcNoteZh: "投稿时勾选「包含AI生成内容」声明",
  },
  {
    id: "channels",
    name: { zh: "视频号", en: "WeChat Channels" },
    cover: { w: 1080, h: 1260 }, // feed 卡片约 6:7
    titleMax: 60,
    tagsMax: 3, // 建议值:#话题# 过多影响可读性
    noteZh: "feed卡片约6:7,封面主体放中间;话题用#话题#格式,建议不超过3个",
    aigcNoteZh: "发表时声明「内容包含AI生成」",
  },
  {
    id: "xiaohongshu",
    name: { zh: "小红书", en: "RedNote" },
    cover: { w: 1080, h: 1440 }, // 首图推荐 3:4
    titleMax: 20, // 平台硬上限:笔记标题 20 字
    tagsMax: 10, // 建议值
    noteZh: "笔记标题上限20字(硬限制);首图3:4;封面+标题的点击率是首要考核",
    aigcNoteZh: "发布时勾选AIGC标注;注意平台对真人内容占比有推荐门槛,纯AI批量内容会限流",
  },
  {
    id: "tiktok",
    name: { zh: "TikTok", en: "TikTok" },
    cover: { w: 1080, h: 1920 },
    titleMax: 90, // caption 上限 2200,但列表展示按前 90 字截断
    tagsMax: 5, // 建议值
    noteZh: "caption上限2200字符,展示截断在90字符左右;话题建议3-5个",
    aigcNoteZh: "开启「AI-generated content」标签",
  },
  {
    id: "shorts",
    name: { zh: "YouTube Shorts", en: "YouTube Shorts" },
    cover: { w: 1280, h: 720 }, // YouTube 缩略图 16:9
    titleMax: 100, // 平台硬上限
    tagsMax: 3, // 标题内 hashtag 建议值
    noteZh: "标题上限100字符;标题内#hashtag建议不超过3个",
    aigcNoteZh: "在YouTube Studio开启「合成内容披露」(Altered content);标签只是透明度信号,不降权",
  },
  {
    id: "reels",
    name: { zh: "Instagram Reels", en: "Instagram Reels" },
    cover: { w: 1080, h: 1920 },
    titleMax: 90, // caption 上限 2200,列表展示截断
    tagsMax: 5, // 建议值
    noteZh: "caption上限2200字符;网格封面中央4:5区域可见,主体放中间",
    aigcNoteZh: "开启「Made with AI」标签",
  },
];

const SPEC_BY_ID = new Map(PLATFORM_SPECS.map((p) => [p.id, p]));

/** 按 id 取规格;未知 id 返回 undefined(调用方过滤,不猜)。 */
export function platformSpec(id: string): PlatformSpec | undefined {
  return SPEC_BY_ID.get(id);
}

/** 过滤出有效平台 id(去重、保持传入顺序)。 */
export function validPlatformIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (SPEC_BY_ID.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
