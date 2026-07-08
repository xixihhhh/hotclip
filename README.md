# HotClip 爆款切片 — 长视频/直播回放，一键切出爆款竖屏短视频

**简体中文** | [English](README.en.md)

> **把几个小时的长视频，筛成能上热门的短视频。** 播客 · 直播回放 · 课程 · Vlog → AI 自动找爆点（金句/冲突/高能瞬间）→ 竖屏 9:16 重构 + 逐字动态字幕 → 直接发**抖音 / 快手 / B站 / 视频号 / 小红书 / TikTok / Reels / Shorts**。
>
> **无积分制 · 无水印 · 不上传 · 不限时长——因为它就跑在你自己的电脑上。** 提供 Windows / macOS 桌面客户端，不会代码也能用。AI 负责找爆点，最终哪条能发、切在哪里，由你定夺。

<p>
  <a href="https://github.com/xixihhhh/hotclip/releases/latest"><img src="https://img.shields.io/github/v/release/xixihhhh/hotclip?label=%E6%9C%80%E6%96%B0%E7%89%88%E6%9C%AC&color=ff5722" alt="最新版本"></a>
  <a href="https://github.com/xixihhhh/hotclip/releases"><img src="https://img.shields.io/github/downloads/xixihhhh/hotclip/total?label=%E4%B8%8B%E8%BD%BD%E9%87%8F&color=ff9800" alt="下载量"></a>
  <img src="https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows%20%7C%20macOS-blue" alt="平台">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/xixihhhh/hotclip?label=%E5%BC%80%E6%BA%90%E5%8D%8F%E8%AE%AE" alt="License"></a>
  <a href="https://github.com/xixihhhh/hotclip/stargazers"><img src="https://img.shields.io/github/stars/xixihhhh/hotclip?style=social" alt="GitHub stars"></a>
</p>

<!-- TODO(P0): 在此处放 30-60 秒实操 demo mp4（README 网页编辑器直接拖入 mp4 生成 user-attachments 页内播放器）：
     内容：拖入直播回放 → 爆点候选卡片弹出 → 一键导出 → 竖屏成片带卡拉OK字幕播放 2 秒 -->

<!-- TODO(P0): 在此处放「成片效果」表格：<table> 并排 2-3 个竖屏成片 <video>（中文播客金句 / 带货直播高能 / 中英混说），每个配一行标题 -->

---

## 界面预览

<p align="center">
  <img src="docs/screenshots/04-highlights.png" width="840" alt="AI 爆点候选:四维打分 + 钩子 + 逐句边界微调">
</p>
<p align="center"><sub><b>AI 通读全文挑爆点</b> —— 每条候选附爆款分、钩子、四维分项（钩子 / 结构 / 价值 / 热点）、悬念句与逐字精确切点;弱片自动标「不建议发布」,勾选取舍全在你手。</sub></p>

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/01-import.png" alt="导入长视频"><br/><sub>① <b>导入</b> 播客 / 直播回放 / 课程 —— 全程本地处理,素材不上传</sub></td>
    <td width="50%"><img src="docs/screenshots/02-engines.png" alt="选择转写引擎"><br/><sub>② <b>选转写引擎</b> —— 三档本地(SenseVoice / Paraformer / FireRedASR2)+ 可选云端,隐私分级明标</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/03-transcript.png" alt="逐字转写"><br/><sub>③ <b>逐字转写</b> —— 带时间戳的逐句稿,是找爆点和字幕的地基</sub></td>
    <td width="50%"><img src="docs/screenshots/05-export.png" alt="一键出片"><br/><sub>④ <b>一键出片</b> —— 竖屏成片直接发,附封面图与 clips.json 元数据</sub></td>
  </tr>
</table>

> 截图为真实界面（演示素材:一段带货直播回放）。**觉得切得准，就点个 ⭐——每颗星都是让更多人不用再给积分制付费的一票。**

## 最近更新

- **[v0.4.3](https://github.com/xixihhhh/hotclip/releases/tag/v0.4.3)**（2026-07-06）工程底座:转写结果本地缓存（同文件重开秒进挑爆点）+ clips.json 处理产出回执（AI 对每条片做了什么，可审计）
- **[v0.4.2](https://github.com/xixihhhh/hotclip/releases/tag/v0.4.2)**（2026-07-05）字幕可读性:语义断行（顺标点/结构助词换行，不再拦腰截断）+ 防闪烁
- **[v0.4.1](https://github.com/xixihhhh/hotclip/releases/tag/v0.4.1)**（2026-07-05）多人对谈:说话人分离字幕按人上色端到端打通
- 开发中（已进主干,随下个版本发布）:开场钩子黄金3秒烧录、响度标准化 -14 LUFS 社媒标准、**镜头切点吸附**（TransNetV2 镜头边界检测,切点自动吸到真实镜头切换上）

完整更新历史见 [Releases](https://github.com/xixihhhh/hotclip/releases)。

## 🚧 项目状态

**「导入 → AI 找爆点 → 竖屏+逐字字幕成片」三步全流程可下载可用**,并已长出说话人分离、气泡特效字幕、气口跳剪、一键全托管等能力,[去下载](https://github.com/xixihhhh/hotclip/releases/latest):

| 里程碑 | 状态 |
|---|---|
| 桌面客户端(Electron,中英双语,导入+媒体探测) | ✅ 已完成 |
| 本地转写(SenseVoice / Paraformer / FireRedASR2 三档 + 云端 ElevenLabs,逐字时间戳,首启自动下载·国内镜像优先) | ✅ 已完成 |
| AI 找爆点(LLM 只引原文不猜时间戳,逐字反向对齐 → 切点精确到词,四维复评打分) | ✅ 已完成 |
| 出片(帧精确切割 + 竖屏 9:16 重构 + 卡拉OK逐字字幕烧录) | ✅ 已完成 |
| 人脸跟随智能取景(镜头级三模式,无人脸自动回退居中裁剪) | ✅ 已完成 |
| 说话人分离 · 气泡特效字幕 · 开场钩子 · 气口跳剪 · 剪口头禅 · 响度标准化 · 转写缓存 · 一键全托管 | ✅ 已完成 |
| 安装包发布(Windows exe + 绿色版 zip + macOS dmg) | ✅ [已发布](https://github.com/xixihhhh/hotclip/releases/latest) |
| 镜头边界检测(切点吸附,TransNetV2 本地推理) | ✅ 已完成(随下版发布) |
| 候选审阅台 · 样式模板 · 多平台发布 · MCP Server | 🗺️ [规划中](docs/PRODUCT-PLAN.md) |

## 三步出片

1. **导入**:把播客、直播回放、课程、Vlog 丢进来(MP4 / MKV / MOV / FLV / TS,也支持纯音频)
2. **挑爆点**:本地逐字转写 → AI 通读全文挑出金句/冲突/高能片段,每条附爆款分、开场钩子和推荐理由,切点精确到词;看不顺眼的取消勾选即可
3. **出片**:一键切出竖屏 9:16 成片,卡拉OK逐字点亮字幕直接烧进画面,文件落在「影片/HotClip」里,打开就能发

## 为什么做 HotClip

市面上的 AI 切片工具,要么**按分钟扣积分**(一期 2 小时播客烧光整月额度,积分月底还清零),要么**必须上传云端**(未发布的素材/客户内容不敢传——参考 2025 年 CapCut 用户协议风波),要么切点稀烂(句子切一半、没上下文),要么**中文支持名不副实**。开源侧则几乎全是命令行/自部署,小白装不起来。

HotClip 的答案:

- 🖥️ **双击就能用**:Windows / macOS 安装包,不用 Python、不用 Docker、不用命令行
- 🔒 **本地优先**:转写、找爆点、切片全在你电脑上跑,素材不上传
- 🆓 **真免费**:开源 AGPL-3.0,无积分制、无水印、不限视频时长
- 🎯 **切点准**:LLM 只负责«挑哪段»,时间戳由逐字转写反向对齐——不让 AI 猜时间
- 🇨🇳 **中文原生**:中文语音识别走专门引擎(SenseVoice,兼顾粤语),界面中英双语,爆点判断的提示词也按内容语言分流——不是英文产品硬翻
- 🤖 **模型自带干粮也行**:默认本地免费模型;要更强的爆点判断,可一键接 [Atlas Cloud](https://www.atlascloud.ai)(一个 Key 用齐中外主流大模型)、fal.ai 或任意 OpenAI 兼容接口

## 对比

| | HotClip | OpusClip / Klap / Vizard 等 SaaS | 剪映/CapCut 智能切片 | FunClip / autoclip 等开源 |
|---|---|---|---|---|
| 价格 | **免费开源** | $15-29+/月,按源视频分钟扣积分,重生成再扣,积分月底清零,退订删项目 | 核心功能进会员/Pro | 免费 |
| 素材去向 | **全程本地,不上传** | 必须上传云端 | 云端处理为主 | 本地 |
| 水印/时长限制 | **无** | 免费档有水印、限时长、项目 3 天过期 | 部分模板有限制 | 无 |
| 小白可用 | **双击安装即用** | 网页版,易用 | 易用 | 命令行/Docker/自部署 |
| 切点质量 | **逐字对齐,精确到词,附理由可否决** | 黑盒打分,常被抱怨断章取义 | 黑盒 | 按句切,无爆点排序 |
| 竖屏字幕 | **9:16 重构 + 逐字点亮字幕内置** | 有(付费档) | 自动字幕已进付费 | 多数无竖屏重构 |

> 一句话:SaaS 的积分制和黑盒是最大怨气来源;开源工具装不起来。HotClip 把两边的坑同时填上。

## 已实现

- **本地逐字转写(三档可选)**:快速 SenseVoice(五语种,170MB)/ 均衡 Paraformer(中文更准,230MB)/ 最准 FireRedASR2(普通话/方言/中英混说,小红书开源,520MB)——全部本地运行、逐字时间戳、首次自动下载(国内镜像优先),模型不带标点的档位自动用标点模型回补;另有**云端档 ElevenLabs**(自带 Key,90+ 语种,只上传提取的音轨、绝不上传视频)
- **AI 找爆点**:LLM 只负责«挑哪段»并引用原文,时间戳由逐字转写反向对齐(逐字精确/首尾锚定/按句对齐三级降级,UI 明示切点质量)——不让 AI 猜时间
- **证据链卡片**:每条候选附爆款分、开场钩子、推荐理由、精确时间边界,可勾选取舍
- **人脸跟随智能取景**:竖屏 9:16 重构自动检测并跟随人脸(镜头级三模式:静止不动/平滑横移/One Euro 跟踪),人不在画面中间也不切歪;无人脸自动回退居中裁剪
- **卡拉OK逐字字幕**:词级时间戳驱动的逐字点亮字幕(ASS/libass),直接烧录进成片,可开关
- **语义断行(免 Key)**:字幕不再按固定字数「拦腰截断」——顺着 ASR 标点模型标出的逗号/顿号在真实子句处换行,长句里没有标点时再回看到最近的结构助词(的/了/着…)断,「十几块的 / 到底有什么区别」这样短语保持完整;等价于头部项目用 LLM 插 `[br]` 的效果,但用本地信号、零额外调用、不需要云 Key
- **气泡特效字幕(Web 渲染引擎)**:用应用内置的 Chromium 离屏逐帧渲染 CSS 字幕层再合成进片——自适应圆角气泡底、关键词渐变金字、弹性入场,这些传统字幕烧录(libass)做不出的效果,一档切换即得;确定性逐帧驱动,同输入必出同片
- **标题贴片**:AI 起的爆款标题自动烧进顶部安全区(黑底白字贴片),切片标配一步到位
- **开场钩子(黄金3秒)**:AI 为每条切片写的悬念句不再只躺在 clips.json——自动大字烧在**开头 2 秒的上三分之一**当文字钩子(前 3 秒抓不住人=直接划走,是短视频完播率的命门),淡入淡出、避开画面中央主体与顶部标题;没写出悬念句的片自动不加,可一键开关
- **AI 复评质量门**:严格评审员二次盲评每条候选,**钩子/结构/价值/热点四维分项打分**,每维一句话理由,另给一条可印上视频开头的悬念句;弱候选透明标记默认不选——托管出的每条都过双重关
- **爆款分=排名不是玄学**:总分由四维加权后按候选间相对排名归一(推荐档 76-99),同一批次内可直接比大小,不受 AI 打分批间漂移影响——商业工具同款做法,诚实标注它是排序器不是播放量预言
- **多人对谈「谁在说话」**:一键开启说话人分离(本地 pyannote+3D-Speaker,零上传),逐句标注谁在说——AI 按说话人挑段、避免把两个人的半句拼成断章取义,气泡字幕还能按人上色;访谈/播客/连麦场景专治「切出来不知道谁说的」
- **去录屏UI**:手机直播录屏的状态栏/固定UI/上下黑边,用时域方差自动检测并裁除(静止的是UI,会动的是内容),检测不到就不裁
- **气口跳剪**:自动剪掉说话间的停顿静音并拼接,字幕时间轴同步重映射——成片节奏像人剪的,不是机切;剪不剪由「无词 **且** 声学静默」双重判定,笑声、掌声、BGM 高潮这些没有台词但有情绪的瞬间不会被误删
- **剪口头禅**:嗯/呃 等语气词和结巴重复自动剪除(词表刻意保守,「然后/那个/句尾的啊」这类真词不动);剪了什么逐条列进 clips.json,你始终知道 AI 动了哪里
- **响度标准化**:每条切片按 EBU R128 归一到 **-14 LUFS 社媒标准**(抖音/TikTok/Reels/视频号 播放同款响度),整批出片音量一致、不再有的太小声有的爆音——平台不会因忽大忽小压流量,观众也不用一直调音量;跳剪拼接后的成片按拼接后的音轨算响度,不是分段各算
- **封面图 + 元数据导出**:每条切片附带封面 JPG(带字幕和标题贴片,平台直传)和 clips.json(标题/钩子/评分/评审意见/时间码/关键词),矩阵运营直接接 CMS;还带**处理产出回执**(有效字幕样式、取景是 face-track 还是回退中心裁、跳剪剪除比与拼接段数、剪了几个口头禅)——AI 到底对每条片子做了什么,一目了然可审计
- **画面声音证据**:响度峰值与镜头切换密度本地采集,注入爆点判断——不再纯文本盲选
- **镜头切点吸附**:TransNetV2 镜头边界检测(31MB ONNX 本地推理,MIT)逐帧找真实镜头切换,切片起止点自动吸附到最近的镜头边界(≤0.8s 外扩优先)——成片不再从半个动作/半次转场开始;**词边界守卫**保证吸附绝不切掉说话,检测失败自动回退不吸附,吸了多少写进 clips.json 回执
- **转写结果本地缓存**:转写是整条流水线最慢的一步;结果按(文件+引擎)缓存在本地,同一个文件下次再开、想换设置多切几条,**跳过重转写秒进挑爆点**(云引擎还顺带省一次 API 费),文件改动或换引擎自动失效
- **一键全托管**:导入后点一个按钮,转写 → 找爆点 → 竖屏+字幕+剪气口成片全自动跑完,人只做最后审片
- **帧精确切割**:快速定位 + 重编码,爆点第一秒不糊不偏;直播回放数小时 FLV/TS 直接进
- **中英双语界面**,新增语言只需一个语言文件

## 规划中

完整规划见 [产品规划文档](docs/PRODUCT-PLAN.md),要点:

- **v0.5 选得准**:候选切片审阅台(拖拽微调边界、一键重生成)· 镜头边界检测(切点吸附镜头边界)· 字幕样式模板/品牌预设 · 端侧小模型初筛降本
- **v0.6 看得见画面**:视觉爆点信号(端侧多模态模型看表情/动作/画面梗)· 多语言翻译字幕 · 英文转写引擎升级
- **v0.7 切完直接发**:多平台一键发布/排期 · 平台规格预设 · 剪映草稿导出
- **v0.8 被 Agent 调用**:本地 MCP Server(让 Claude 等直接驱动切片流水线)· 录播监听全自动 · 弹幕热度爆点信号
- **合规内建**:AIGC 标识(显式+隐式,对齐 2025-09 生效的国家标识办法);仅面向**自有内容与已授权切片**,不做搬运工具

想投票决定先做哪个?到 [Discussions](https://github.com/xixihhhh/hotclip/discussions) 留言。

## 下载安装

**[⬇️ 去 Releases 页下载最新版](https://github.com/xixihhhh/hotclip/releases/latest)**

| 平台 | 文件 |
|---|---|
| Windows 安装版 | `HotClip-x.y.z-win-x64.exe` |
| Windows 绿色版(免安装,解压即用)| `HotClip-x.y.z-win-x64.zip` |
| macOS(Apple 芯片)| `HotClip-x.y.z-mac-arm64.dmg` |

> ⚠️ 当前版本未做代码签名:Windows SmartScreen 提示时点「更多信息 → 仍要运行」;macOS 首次打开用右键 → 打开(或到「系统设置 → 隐私与安全性」允许)。代码签名已在规划中。

## 快速开始(开发者)

```bash
git clone https://github.com/xixihhhh/hotclip.git
cd hotclip
pnpm install
pnpm dev        # 启动桌面应用(开发模式)
pnpm test       # 跑单元测试
```

## 技术栈

Electron + React 19 + TypeScript + Tailwind 4 · ffmpeg(打包内置,无需自装)· sherpa-onnx 本地转写 + 说话人分离 · libass 卡拉OK逐字字幕 + 离屏 Chromium 气泡特效字幕引擎 · LLM 爆点检测(Atlas Cloud / 本地 Ollama / 任意 OpenAI 兼容接口,BYO Key)

### 站在这些开源项目的肩膀上

| 项目 | 在 HotClip 中的角色 |
|---|---|
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | 本地语音识别运行时(纯 CPU 可跑) |
| [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) / [FunASR](https://github.com/modelscope/FunASR) | 五语种快速转写 / Paraformer 中文转写与标点 |
| [FireRedASR](https://github.com/FireRedTeam/FireRedASR) | 最高精度档:普通话/方言/中英混说 |
| [pyannote-audio](https://github.com/pyannote/pyannote-audio) + [3D-Speaker](https://github.com/modelscope/3D-Speaker) | 说话人分离(本地零上传) |
| [FFmpeg](https://ffmpeg.org/) + [libass](https://github.com/libass/libass) | 帧精确切割 / 字幕烧录 |
| [onnxruntime](https://github.com/microsoft/onnxruntime) | 端侧模型推理 |

## 常见问题

**HotClip 是免费的吗?**
是。开源(AGPL-3.0)、本地运行、无水印、无积分制。可选的云端大模型按你自己的 Key 计费。

**HotClip 和 OpusClip/Klap 这类工具的区别?**
最大区别是素材不出你的电脑:OpusClip 等 SaaS 必须上传云端、按源视频分钟扣积分(积分月底清零),免费档带水印。HotClip 开源免费、本地处理、无水印、不限时长,AI 切点还附理由可审计。详见上方[对比表](#对比)。

**需要联网吗?**
转写、字幕、切片、导出全程离线。只有「AI 找爆点」这一步默认调用云端大模型(用你自己的 Key),不想联网可以接本机 Ollama——那就 100% 离线。

**怎么把播客/直播回放变成短视频?**
导入文件 → AI 转写并标出爆点(可手动增删调边界)→ 一键导出竖屏成片。

**支持中文视频吗?**
支持。中文识别走专用引擎(SenseVoice/Paraformer 一类),准确率显著高于通用模型;界面、字幕、prompt 都针对中文内容做了适配。

**需要显卡吗?**
不需要。本地转写用的是 int8 量化的 SenseVoice 小模型,普通 CPU 就能跑;找爆点的大模型在云端(或你本机的 Ollama)。

## 授权与边界

- 代码:**AGPL-3.0-only**
- HotClip 面向**你自己的内容**或**已获授权的切片**(如主播切片授权计划)。请遵守各平台二创与授权规则——未经授权的影视/直播搬运不受支持,也不欢迎。

## 社区

- 🐛 [提 Bug / 安装求助](https://github.com/xixihhhh/hotclip/issues)
- 💡 [功能建议与 Roadmap 讨论](https://github.com/xixihhhh/hotclip/discussions)

[![Star History Chart](https://api.star-history.com/svg?repos=xixihhhh/hotclip&type=Date)](https://star-history.com/#xixihhhh/hotclip&Date)

**⭐ 觉得有用就点个 Star——新版本发布时你会第一时间看到。**
