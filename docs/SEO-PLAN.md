# HotClip SEO / GEO 关键词规划（2026-08）

> 数据来源：百度/Bing/Google 下拉联想（38 个种子词两轮抓取）+ 知乎/CSDN/竞品标题分析 + GitHub SEO 实测资料。
> 本文档是官网（docs/）与 README 文案的选词依据，改文案前先对照此表。

## 一、核心结论（先读这个）

1. **「直播切片」是全网最强场景词**：百度联想 10 条全满、Bing/Google 也有完整联想链（怎么做/软件/授权/赚钱）——官网 title、H1、README 首行必须含这个词。
2. **三个避坑**：
   - 裸词「切片软件」联想全是 3D 打印（cura/orca/拓竹），必须写「**视频**切片」「**直播**切片」；
   - 「AI切片」一半联想指向 Illustrator 切图，要写「**AI视频切片**」；
   - 「切片手」被「切片手术」淹没，只在正文语境用，不做独立关键词。
3. **「免费」是该词族最高频修饰**（ai剪辑软件免费 / 直播切片自动剪辑软件免费）——与产品卖点完全咬合，title/描述里显式带「免费开源」。
4. **竞品替代词优先级**：OpusClip（免费替代/中文版/国内怎么用）> 剪映智能切片（免费）> FunClip（对比）> Vizard。klap 在中文世界近零搜索量（被护肤品牌 klapp 淹没），不做。
5. **GitHub 站内搜索只看 repo name / description / topics，README 正文不参与**——中文词吃 Google 流量（README H2/FAQ 问句），英文词吃 GitHub 站内（description 英文后缀 + topics）。

## 二、中文词库分层

### T1 核心词（title / H1 / og）
| 关键词 | 用途 |
|---|---|
| 直播切片 | 官网 title、H1、README 首行、repo description 前置 |
| AI视频切片工具 | 官网 title（「免费开源的 AI 直播切片 / 视频切片工具」） |
| 直播切片自动剪辑软件（免费） | 首屏 tagline / meta description |
| 长视频转短视频 | H1 副句「长视频一键切成爆款竖屏短视频」 |
| AI剪辑软件免费 | meta description / README 徽章区文案 |
| 自动剪辑软件 | meta / 正文首段 |
| 一键切片 | 组合词：「长视频一键切片」「一键切成」 |

### T2 长尾词（H2 / 功能卡片 / FAQ）
| 关键词 | 承接位置 |
|---|---|
| 直播回放剪辑 | FAQ「直播回放怎么剪辑成精彩视频发布?」 |
| 自动加字幕的软件 | 字幕功能卡 H3「自动加字幕:卡拉OK逐字点亮」 |
| 卡拉OK字幕制作软件 | 同上（独占功能词，竞争极小） |
| 口播剪辑软件 | 功能卡「口播剪辑:去气口、剪口头禅」+ 人群区 |
| 去气口软件 | 同上 + FAQ「视频如何去气口?」（联想少=可独占） |
| 横屏转竖屏软件 | 功能卡「横屏转竖屏 9:16,人脸自动跟随」 |
| 说话人分离工具 | 功能卡 + README 技术段（吃开发者流量） |
| 直播高光切片 | AI 爆点功能卡「自动识别直播高光」 |
| 录播切片 / 虚拟主播切片 | 人群区正文（B站/V圈生态词） |
| 播客视频化 | 播客人群卡「播客剪成短视频」 |
| 切片带货怎么做 / 直播切片授权 | FAQ（合规角度：强调已授权切片） |
| whisper 字幕生成 | README 技术说明段（本地 ASR 同类体验） |

### T3 竞品替代词（对比区 / FAQ / 对比子页）
OpusClip 免费替代 · opus clip 中文版 · opusclip 国内怎么用 · 剪映智能切片 免费 · FunClip 对比 · 直播切片工具 免费 开源

### 问句词（FAQ 标题原文使用）
直播切片怎么做（详细步骤）/ 有什么免费的AI切片软件 / 直播回放怎么剪辑成精彩视频发布 / 长视频怎么剪成短视频 / 视频怎么自动加字幕 / 视频如何去气口 / 直播切片如何申请授权 / opus clip 国内怎么用 / 剪映可以自动切割片段吗 / 需要显卡吗

## 三、英文词库（en.html / README.en.md）

- **T1**：AI video clipper · AI clipping tool · free Opus Clip alternative · open source Opus Clip alternative · long video to shorts converter · turn long videos into viral shorts · no watermark · runs locally
- **T2**：podcast to shorts ai free · podcast clip generator · twitch clips to tiktok（限定 clip your own VODs）· auto captions free no watermark · karaoke captions ai · remove filler words from video free · ai silence remover · ai highlights generator · auto reframe 9:16 face tracking · repurpose video ai free · unlimited minutes no credits
- **T3**：opus clip alternative（free no watermark / open source）· vizard alternative free · klap alternative free · submagic alternative free · descript alternative free
- **title 定稿**：`HotClip — Free Open-Source AI Video Clipper | Turn Long Videos into Viral Shorts, Locally, No Watermark`
- **排除**：clip farming（搬运联想）、opus codec 歧义词、地域 apk 变体。

## 四、GitHub 仓库设置（需在 GitHub 上操作）

1. **About description**（中文搜索词前置+英文殿后，≈250 字符内）：
   > 免费开源的 AI 直播切片 / 视频剪辑工具:长视频、直播回放一键切成爆款竖屏短视频,AI 找爆点+自动字幕+横屏转竖屏,本地运行无水印不限时长。Free open-source AI video clipper: turn long videos & livestreams into viral vertical shorts, locally. Opus Clip alternative.
2. **Topics（20 个，宽窄混搭）**：`ai` `video` `video-editing` `video-clipping` `clips` `short-video` `vertical-video` `subtitles` `captions` `asr` `speech-recognition` `electron` `desktop-app` `douyin` `tiktok` `bilibili` `livestream` `podcast` `local-first` `opus-clip-alternative`
3. **Social preview**：Settings → Social preview 上传 `docs/social-preview.png`（1280×640，<1MB，不透明）。
4. **Releases 标题带关键词**（Google 单独收录 releases 页）。

## 五、GEO（AI 搜索引擎可见性）

- `docs/llms.txt` 保持最新（已按新文案更新）；FAQPage/SoftwareApplication/HowTo 三种 JSON-LD 已内建。
- **robots.txt 注意**：GitHub Pages 项目页（`xixihhhh.github.io/hotclip/`）无法控制域名根目录的 robots.txt，爬虫只读根目录——好消息是根目录没有 robots.txt 时默认全放行（含 GPTBot/ClaudeBot/PerplexityBot）。sitemap 通过 **Google Search Console / Bing Webmaster 手动提交** `https://xixihhhh.github.io/hotclip/sitemap.xml`。
- 内容写法：答案先行（FAQ 首句直接回答）、具体数字（-14 LUFS、170MB 模型、3 步）、可核查表述——AI 引擎引用的是「可提取的事实密度」。

## 六、后续内容机会（流量放大器，未做）

- 为 T2 词各做一个 CapCut 式关键词工具页（如「直播回放怎么剪成短视频」教程页），成本低、吃长尾。
- 中文对比页：「HotClip vs 剪映智能切片」「HotClip vs FunClip」（对标已有英文 opus-clip.html）。
- B站/知乎发布实操教程，标题用问句词原文。
