# HotClip 产品规划（2026H2）

> 基于 2026-07 四路调研整合：商业/开源竞品格局、用户真实痛点、2025-2026 前沿技术可行性、GitHub 头部同类项目逐仓拆解。所有论断在文末来源报告中有出处。

---

## 一、定位（一句话，全网统一复读）

> **你的视频不出你的电脑——开源免费的本地 AI 切片工作台：AI 提爆点、你 10 秒定稿、一键出片直发全网。**
>
> 英文版（GEO 共识信号，所有渠道统一措辞）：
> **HotClip — free, open-source, local-first Opus Clip alternative. Desktop app, no uploads, no credits, no watermark.**

三个支点：
1. **信任反面**：CapCut 2025.6 霸王条款事件 + SaaS「积分月清零/退订删项目」的敌意设计，让「本地、不上传、真免费」有真实情绪土壤。
2. **场景卡位**：长视频/直播回放（2–8 小时）恰是按源分钟计费最疼的场景。
3. **形态独占**：开源阵营全是 CLI/Gradio/自部署，**没有第二个开箱即用的桌面应用**；且无人同时具备「取景+卡拉OK字幕+跳剪+口头禅+响度+回执」这条完整制作链。

## 二、竞品格局速览

| 阵营 | 关键事实 | 对 HotClip 的含义 |
|---|---|---|
| OpusClip | SoftBank 注资，转型「AI 增长 Agent 平台」；ClipAnything 多模态找片段；官方已出 MCP/Claude Skill | 行业方向标：Agent 化 + 多模态是主线；纯文本选片差距会拉大 |
| Vizard / Klap | 免费档慷慨获客（60min/月）但水印+项目3天过期 | 「无期限、无水印」要持续放大声量 |
| Munch | **已放弃自助 SaaS 转人工代剪** | 无差异化的中间位会死；HotClip 靠开源+本地站稳两极之外的位置 |
| 剪映/CapCut | 智能长转短免费可用，但云端+ToS 信任危机+核心功能进会员 | 中文侧最大对手也是最好的反衬素材 |
| 度加/智影/闪剪 | 快剪（气口/语气词）已是标配；矩阵混剪是企业刚需 | 单点功能不是护城河，「本地+透明+免费」组合才是 |
| 开源（FunClip 5.9k / ShortGPT 7.7k / bilive 3.2k / autoclip 6k） | 全部无桌面端；bilive 证明「录→切→自动投稿」闭环是刚需 | 桌面形态独占；发布闭环是开源侧最大空白 |

**已被追平、不再是卖点**（README 里降权为「及格线」）：人脸跟随 9:16、卡拉OK字幕、开场钩子、剪填充词。
**真护城河**：本地+开源+桌面、无积分焦虑、制作链完整度、切点可审计（证据链+clips.json 回执）。

## 三、用户痛点优先级（附产品应对）

| 级别 | 痛点 | 应对 |
|---|---|---|
| P0 | AI 选片不可信（「20 条只有 2-3 条能发」，修 AI 产出比自己剪还慢） | **候选审阅台**：拖拽微调边界、按语义句扩展、一键重生成——把「全托管」升级为「全托管+快速干预」 |
| P1 | 计费敌意（按源分钟扣积分、积分清零、退订删项目） | 已解决；营销持续放大 |
| P2 | 隐私/版权恐慌（商单/NDA 素材不敢上传） | 已解决；官网/README 用 CapCut ToS 事件做对照 |
| P3 | 多平台发布/排期 | 浏览器自动化发布（Electron 内嵌 Chromium 天然优势）+ TikTok/YouTube 官方 API |
| P4 | 直播录播 7×24 无人值守 | watch 文件夹/对接录播姬生态 + 弹幕热度信号 |
| P5-P8 | 翻译字幕、B-roll、品牌模板、矩阵吞吐 | 见路线图 |

## 四、产品路线图

### v0.5 —「选得准、批量稳」（补短板）
- **候选切片审阅台**（P0 痛点，影响极高/成本低，clips.json 基础已具备）
- **镜头边界检测 TransNetV2/AutoShot（ONNX）**：切点吸附镜头边界 + 镜头节奏进爆点打分（3-4 人日，收益立现）
- **样式模板/品牌预设**：字幕样式/钩子/logo/安全区一次配置全局复用（竞品付费墙功能）
- **端侧小 LLM 两级漏斗**：Qwen3-4B（Ollama）初筛 → 云端精排，LLM 成本降一个量级，强化本地叙事

### v0.6 —「看得见画面、说得出外语」（追平前沿）
- **视觉爆点信号**：Qwen3-VL 4B/8B 端侧抽帧（Apache 2.0）+ 可选 Gemini Flash 云端精判（视频 $0.0155/分钟级）
- **人脸表情峰值信号**（复用现有 face-track 管线；⚠️ 避开 InsightFace 非商用权重与 AGPL 的 YOLO-face，用 YuNet/emotion-ferplus）
- **多语言翻译字幕**（先中↔英烧录，双语定位天然合拍）
- **英文 ASR 升级**：Parakeet TDT 0.6B v3 ONNX（CPU 快过 whisper-turbo，CC-BY-4.0）；跟踪 Qwen3-ASR + ForcedAligner 改善逐字对齐

### v0.7 —「切完直接发」（发布闭环，开源侧最大空白）
- **多平台发布**：Electron 内嵌浏览器自动化（抖音/B站/视频号/快手/小红书，参考 social-auto-upload；明示封号风险）+ TikTok Content Posting API / YouTube Data API
- **平台规格预设 + 平台标题/hashtag 生成**（clips.json 已有素材）
- 剪映草稿导出（原规划保留）

### v0.8 —「被 Agent 调用、吃下直播」（第二曲线）
- **HotClip MCP Server（本地 stdio）**：「给我这个 4 小时录播，切 10 条爆点」→ Claude 直接驱动本地管线。OpusClip 已趟路，「本地 MCP 切片器」是空白位，开发者传播杠杆最大
- **录播监听模式**：watch 文件夹，回放落盘即自动全托管（对接 bilive/录播姬生态）
- **弹幕/聊天热度爆点信号**：导入 B 站/Twitch 弹幕与语义分析融合打分（中文直播场景无人做好，差异化尖刀）

### 暂缓
图生视频 B-roll（成本/可控性差）、口型同步（等 dubbing 场景成立，届时选 MIT 的 MuseTalk）、直播实时切片（sherpa-onnx streaming 已验证可行，属第二曲线后段）。
低成本可顺手做：Real-ESRGAN-ncnn-vulkan 超分（官方便携可执行文件，spawn 即用，2-3 人日）、Pexels B-roll（API 免费商用）。

## 五、增长规划（SEO / GEO / 渠道）

### 5.1 已执行（2026-07-08）
- ✅ repo description 换为英文主导竞品狙击型（306 字符，含 "Opus Clip alternative / local / no watermark" + 中文尾注）
- ✅ homepage 指向 `releases/latest`
- ✅ topics 调整为 20 个：换入 `ai` `video-editing` `subtitles` `speech-recognition` `local-first` `desktop-app`，换出低流量中文平台词（保留 `douyin` 代表中文身份）

### 5.2 待手动执行（需要仓库管理员确认）
- **删 5 个 CI 残留草稿 release**（electron-builder 自动创建，附件与正式版重复）：
  `for id in 349290690 349161774 349150406 349080462 348953914; do gh api -X DELETE repos/xixihhhh/hotclip/releases/$id; done`
- **上传社交预览图**（Settings → Social preview，1280×640，<1MB）：左侧竖屏成片截图 + 右侧「本地免费 · 无水印 · 长视频→爆款竖屏」。**被拆解的全部竞品（含 9.6 万星的 MoneyPrinterTurbo）都没做这件事**，10 分钟拿下独占。

### 5.3 README 改造清单

**P0（本周，直接影响转化）**
1. **30-60 秒实操 demo mp4** 放「界面预览」之前（README 编辑框直拖 mp4 → user-attachments 页内播放器）。视频工具 README 最大单一杠杆：前三屏没有「动的成片」，一切文字承诺都不可信。
2. **成片效果表格**：`<table>` 并排 2-3 个竖屏成片 `<video>`（中文播客金句/带货直播高能/中英混说），用户买的是「切出来的片什么样」不是界面。
3. **补徽章行**（当前一个没有）：release + downloads + platform + license + stars(social)，放标题正下方；忌堆砌。
4. **What's New 段**：最近 3 版一句话更新链 release——4 天 7 个版本的活跃度完全没被看见。

**P1（两周内，发现性与社区）**
5. **双语拆分文件**：README.md 中文 + README.en.md 英文，第 2 行 `简体中文 | English`（学 FunClip/MPT；现单文件混排把前三屏拉成六屏，语言切换藏在第 11 行）。
6. 英文正文显式点名 "alternative to OpusClip, Klap, Vizard"（SamurAIGPT 靠 description+正文竞品词吃了两年被动流量）。
7. **开 Discussions + 置顶 issue**：①安装求助直达 ②Roadmap 投票（把「规划中」搬过去让用户投票，冷启动期每个投票者都是留存用户）；配 bug/feature issue 模板。
8. 社区入口：微信群二维码（中文切片人群在微信不在 Discord）+ 邮箱；Star History 图 + demo 后加一句求星 CTA。

**P2（一个月内）**
9. **GitHub Pages 落地页**：一页纸（demo 视频+三步流程+下载按钮），改绑 homepage；加 JSON-LD SoftwareApplication + FAQ schema；顺手放 llms.txt（不指望有效果）。
10. 官网两个对比页：`/alternatives/opus-clip`（英）+「AI 切片工具对比」（中）——竞品全做了 alternatives 页，开源身份在 "free/open source/local" 修饰词长尾上碾压。
11. **国内网盘镜像**（夸克/百度）：国内裸连 GitHub Release 常失败，中文桌面工具的隐形流失大头（学 MPT）。
12. 上游生态互链：sherpa-onnx/SenseVoice/FireRedASR/pyannote 致谢表格；向上游仓库提 "who's using" PR 反向导流。
13. 示例素材包：5 分钟 CC 授权视频 +「3 分钟出第一条片」引导（ClipsAI 死于让用户先凑素材才能看到效果）。
14. FAQ 加「HotClip vs OpusClip?」「需要联网吗?」条目，报错类 FAQ 贴**完整报错原文**（搜索直接命中）。

**避坑（竞品血泪）**：第一屏不放赞助/返利；README 不膨胀成运维手册（autoclip 868 行无一图）；徽章用动态 shields 不写死数字；commit 节奏本身是最强营销信号，宁慢勿断。

### 5.4 GEO 行动清单（AI 引擎推荐 = 新的排名第一）

核心机制是**共识信号**：同一定位在多个独立来源反复出现，AI 才敢推荐。llms.txt 实测无效（AI 爬虫命中率 0.1%），不投入。

| 动作 | 时间 | 说明 |
|---|---|---|
| 提交 opensourcealternative.to / alternativeto.net / openalternative.co | 本周 | 目录页是 AI 回答 "alternative" 类问题的高频引用源 |
| PR 进 awesome 清单 | 本周 | `awesome-free-opusclip-alternatives`（已存在！）、awesome-electron、awesome-ai-video 等 3+ |
| Reddit 回答式渗透 | 持续 | r/NewTubers、r/podcasting、r/videoediting、r/selfhosted、r/opensource；90/10 规则+利益披露；Perplexity 24h 内即可引用 Reddit 新帖 |
| 知乎 3-5 答 + 1 专栏 | 2 周内 | **知乎即中文 GEO**（Kimi/豆包 RAG 主要中文语料源）；把自己放进客观对比 |
| 每月 GEO KPI 实测 | 持续 | 用 "best free opus clip alternative" /「开源 AI 切片工具」问 ChatGPT/Perplexity/Kimi/豆包，记录出现率 |

### 5.5 渠道发布节奏（Trending 冲刺）

GitHub Trending 看 **star 加速度**而非总量 → 把流量脉冲压进同一个 48-72 小时窗口：

**冲刺窗口（建议 v0.5 发布时）**：Show HN（周二-四 8-10AM PT，标题 "Show HN: HotClip – open-source local alternative to OpusClip"，5 分钟内跟工程师口吻 founder comment）+ Product Hunt + V2EX 分享创造 + B站实测视频 + 即刻/微博，同 48h 打出。
**中文长线**：B站 3-5 分钟「白嫖版 OpusClip」实测（中文开源第一涨星引擎）→ 少数派 Matrix 投稿 → 小众软件自荐 → 小红书「不用买会员的 AI 切片」教程（切片副业人群）。
**英文长线**：dev.to/daily.dev 技术长文（如「为什么 LLM 不该猜时间戳——逐字反向对齐架构」，HN 二次传播素材）；Hugging Face Space 轻量 demo（贴转写→出爆点+打分）回链 GitHub。

### 5.6 目标关键词（承载页对应）

- 英文核心：`opus clip alternative free` `open source opus clip alternative`（官网 alternatives 页+topic）、`ai clip generator free no watermark`（官网首页）、`long video to shorts ai`（README H1 已占）、`local video transcription no upload`（**蓝海**：local/privacy/no-upload 角度无竞品占位）
- 中文核心：「AI切片工具 免费」「直播切片工具」（知乎/B站）、「OpusClip 免费替代」（知乎+官网）、「长视频转短视频 AI」（B站标题）、「本地 AI 剪辑 不上传」（V2EX/少数派）、「切片带货 工具 免费」（小红书）

## 六、节奏与 KPI

| 时间 | 里程碑 | KPI |
|---|---|---|
| 本周 | README P0 四项 + 社交预览图 + 目录站/awesome 提交 + 删草稿 release | 元数据全就位 |
| 2 周 | README 双语拆分 + Discussions/模板 + 知乎/B站首批内容 | 首批外部反链 5+ |
| 1 个月 | v0.5（审阅台+镜头检测+模板）+ GitHub Pages 官网 | 500 stars（Trending 冲刺窗口） |
| 3 个月 | v0.6（视觉爆点+翻译字幕）+ 对比页 SEO 收录 | 2k stars；GEO 实测 4 引擎出现 ≥2 |
| 6 个月 | v0.7 发布闭环 + v0.8 MCP/直播 | 5k stars（对标 FunClip/autoclip 量级）；「本地 MCP 切片器」心智占位 |

---

*调研来源：四份完整报告（竞品与用户需求 / 前沿技术 / SEO·GEO 增长 / GitHub 竞品仓库拆解）生成于 2026-07-08，关键出处已内联；如需原文可向维护者索取。*
