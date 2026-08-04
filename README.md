<div align="center">

<a href="https://github.com/xixihhhh/hotclip/releases/latest">
  <img src="docs/readme-hero.png" alt="HotClip 爆款切片 — 本地 AI · 一键切片:长视频、直播回放一键切成爆款竖屏短视频" width="100%">
</a>

# HotClip 爆款切片 — 免费开源的 AI 直播切片 / 视频剪辑工具

**长视频、直播回放一键切成爆款竖屏短视频**

**简体中文** | [English](README.en.md) | [官网](https://xixihhhh.github.io/hotclip/) | [下载](https://github.com/xixihhhh/hotclip/releases/latest) | [FAQ](#常见问题) | [反馈](https://github.com/xixihhhh/hotclip/issues)

<p>
  <a href="https://github.com/xixihhhh/hotclip/releases/latest"><img src="https://img.shields.io/github/v/release/xixihhhh/hotclip?label=%E6%9C%80%E6%96%B0%E7%89%88%E6%9C%AC&color=ff5722" alt="最新版本"></a>
  <a href="https://github.com/xixihhhh/hotclip/releases"><img src="https://img.shields.io/github/downloads/xixihhhh/hotclip/total?label=%E4%B8%8B%E8%BD%BD%E9%87%8F&color=ff9800" alt="下载量"></a>
  <img src="https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows%20%7C%20macOS-blue" alt="平台">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/xixihhhh/hotclip?label=%E5%BC%80%E6%BA%90%E5%8D%8F%E8%AE%AE" alt="License"></a>
  <a href="https://github.com/xixihhhh/hotclip/stargazers"><img src="https://img.shields.io/github/stars/xixihhhh/hotclip?style=social" alt="GitHub stars"></a>
</p>

**AI 自动找爆点(附理由) · 横屏转竖屏 9:16 · 自动加字幕(卡拉OK逐字) · 去气口剪口头禅**

无水印 · 无积分制 · 不限时长 · 素材不上传 · 连注册都不用

</div>

## ⬇️ 下载安装

**[去 Releases 页下载最新版 »](https://github.com/xixihhhh/hotclip/releases/latest)**

| 平台 | 文件 | 说明 |
|---|---|---|
| Windows 安装版 | `HotClip-x.y.z-win-x64.exe` | 双击安装即用 |
| Windows 绿色版 | `HotClip-x.y.z-win-x64.zip` | 免安装,解压即用 |
| macOS(Apple 芯片) | `HotClip-x.y.z-mac-arm64.dmg` | 拖进「应用程序」 |

> ⚠️ 当前版本未做代码签名:Windows SmartScreen 提示时点「更多信息 → 仍要运行」;macOS 首次打开用右键 → 打开(或到「系统设置 → 隐私与安全性」允许)。代码签名已在规划中。
>
> 不用 Python、不用 Docker、不用命令行——下载安装包双击即开。

<!-- TODO(P0): 在此处放 30-60 秒实操 demo mp4(README 网页编辑器直接拖入 mp4 生成 user-attachments 页内播放器):
     内容:拖入直播回放 → 爆点候选卡片弹出 → 一键导出 → 竖屏成片带卡拉OK字幕播放 2 秒 -->

<!-- TODO(P0): 在此处放「成片效果」表格:<table> 并排 2-3 个竖屏成片 <video>(中文播客金句 / 带货直播高能 / 中英混说),每个配一行标题 -->

## 直播切片怎么做?三步出片

<p align="center">
  <img src="docs/readme-story.png" alt="一条长视频变成多个爆款短片:AI 智能识别高光时刻,一键生成竖版爆款短视频" width="100%">
</p>

1. **导入**:把播客、直播回放、课程、Vlog 丢进来(MP4 / MKV / MOV / FLV / TS,纯音频也行),数小时的直播回放直接进,全程本地处理
2. **AI 找爆点**:本地逐字转写 → AI 通读全文挑出金句、冲突、高能片段,每条附**爆款分、开场钩子和推荐理由**,切点精确到词;看不顺眼的取消勾选即可
3. **一键出片**:竖屏 9:16 成片直接导出——人脸跟随取景、卡拉OK逐字字幕、标题贴片、响度归一,附封面图和发布文案,打开就能发**抖音 / 快手 / B站 / 视频号 / 小红书 / TikTok**

## 界面预览

<p align="center">
  <img src="docs/screenshots/04-highlights.png" width="840" alt="AI 爆点候选:四维打分 + 钩子 + 逐句边界微调">
</p>
<p align="center"><sub><b>AI 通读全文挑爆点</b> —— 每条候选附爆款分、钩子、四维分项(钩子 / 结构 / 价值 / 热点)、悬念句与逐字精确切点;弱片自动标「不建议发布」,勾选取舍全在你手。</sub></p>

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

> 截图为真实界面(演示素材:一段带货直播回放)。**觉得切得准,就点个 ⭐——每颗星都是让更多人不用再给积分制付费的一票,Star + Watch 还能第一时间收到新版本通知。**

## 谁在用:直播切片 · 切片带货 · 播客剪辑 · 口播剪辑

- **主播 / 切片手(直播切片、录播切片)**:下播后把几小时直播回放自动切成高光短视频;开「录播监听」后 7×24 无人值守,录完自动出片;弹幕热度直接进爆点判断
- **带货 / 矩阵团队(切片带货,已授权)**:商品讲解模式按转化逻辑选段,一键全托管批量出片,每条附发布文案、封面图与 clips.json 元数据,120+ 违禁词规则发布前点名
- **播客主(播客剪辑、播客视频化)**:纯音频也能出片——自动合成波形动画画面 + 金句字幕,播客节目直接变竖屏视频
- **知识区 UP 主 / 口播博主(口播剪辑)**:自动去气口、剪口头禅、删停顿,长口播变利落短视频,字幕逐字点亮

## 和 OpusClip、剪映智能切片的区别

市面上的 AI 切片工具,要么**按分钟扣积分**(一期 2 小时播客烧光整月额度,积分月底还清零),要么**必须上传云端**(未发布素材/客户内容不敢传),要么切点稀烂、中文支持名不副实;开源侧则几乎全是命令行,小白装不起来。HotClip 把两边的坑同时填上:

| | HotClip | OpusClip / Klap / Vizard 等 SaaS | 剪映/CapCut 智能切片 | FunClip / autoclip 等开源 |
|---|---|---|---|---|
| 价格 | **免费开源** | $15-29+/月,按源视频分钟扣积分,积分月底清零 | 核心功能进会员/Pro | 免费 |
| 素材去向 | **全程本地,不上传** | 必须上传云端 | 云端处理为主 | 本地 |
| 水印/时长限制 | **无** | 免费档有水印、限时长、项目 3 天过期 | 部分模板有限制 | 无 |
| 账号 | **无需注册** | 需注册,退订删项目 | 需登录 | 无 |
| 小白可用 | **双击安装即用** | 网页版,易用 | 易用 | 命令行/Docker/自部署 |
| 切点质量 | **逐字对齐精确到词,附理由可否决** | 黑盒打分,常被抱怨断章取义 | 黑盒 | 按句切,无爆点排序 |
| 竖屏字幕 | **9:16 重构 + 逐字点亮字幕内置** | 有(付费档) | 自动字幕已进付费 | 多数无竖屏重构 |

<sub>竞品信息核对于 2026-07,具体以各家官网为准。详细英文对比:[HotClip vs OpusClip](https://xixihhhh.github.io/hotclip/alternatives/opus-clip.html)</sub>

## 功能一览

> 「导入 → AI 找爆点 → 竖屏+逐字字幕成片」三步全流程可下载可用。每组点开看细节——细节里全是真功能,不是形容词。

### 🎙️ 本地转写:三档引擎,逐字时间戳

快速 SenseVoice(五语种,170MB)/ 均衡 Paraformer(中文更准)/ 最准 FireRedASR2(普通话/方言/中英混说)——全部本地运行、普通 CPU 就能跑,首次自动下载(国内镜像优先、断点续传);另有云端档 ElevenLabs(自带 Key,只上传音轨)。

<details>
<summary><b>展开细节</b>:转写缓存 · 逐句稿即点即改 · 热词词表 · 说话人分离</summary>

- **转写结果本地缓存**:同一个文件下次再开、换设置多切几条,跳过重转写秒进挑爆点;文件改动或换引擎自动失效
- **逐句稿即点即改(转写纠错)**:每句 hover 出铅笔当场改,字幕、双语翻译、发布文案全用修正后文本,该句卡拉OK时间轴自动重建
- **热词词表(专有名词一次纠错,期期自动修正)**:人名/品牌/术语改一处,一键应用到全片同错句并入词表;之后每次转写自动整词替换,词表更新后同素材直接用缓存重放、不重跑识别
- **多人对谈「谁在说话」**:一键说话人分离(本地 pyannote + 3D-Speaker,零上传),逐句标注谁在说;AI 按说话人挑段不断章取义,气泡字幕按人上色
</details>

### 🔥 AI 找爆点:六路证据链,每一刀都有理由

LLM 只负责«挑哪段»并引用原文,时间戳由逐字转写**反向对齐**——不让 AI 猜时间。每条候选附爆款分、开场钩子、推荐理由与四维分项,弱片自动标「不建议发布」。

<details>
<summary><b>展开细节</b>:复评质量门 · 弹幕/表情/视觉信号 · 参考爆款 · 省钱漏斗 · 商品模式</summary>

- **AI 复评质量门**:严格评审员二次盲评,钩子/结构/价值/热点四维分项打分,每维一句话理由,另给一条可烧上片头的悬念句
- **爆款分=排名不是玄学**:四维加权后按候选间相对排名归一(推荐档 76-99),同批次可直接比大小,不受批间漂移影响
- **画面声音证据**:响度峰值与镜头切换密度本地采集注入判断,不再纯文本盲选
- **弹幕热度信号**:自动发现录播旁同名弹幕 .xml(录播姬约定),滑窗密度+高能词加权圈出观众实时高能段——观众逐秒投的票,证据力最强
- **表情峰值信号**:YuNet + FER+(几 MB 的 MIT 协议模型)找大笑/惊讶/激动峰值,零配置让 AI「看见」情绪爆点
- **视觉爆点信号(可选)**:本机 Ollama 视觉模型抽帧研判画面高能时刻,专治逐字稿里看不见的画面梗;抽帧接触表九帧拼一张,VLM 调用数 20→3
- **参考视频驱动**:丢一条想对标的爆款切片,本地实测节奏生成风格画像,选段向对标靠拢(CLI `--reference`)
- **审阅反馈回流**:你采用/否决的候选自动落进本地偏好档,下次「同类优先/同类少选」,越用越懂你;偏好数据不出本机
- **端侧两级漏斗(省钱)**:本机小模型先初筛,云端只精读入围段——长视频云端 token 花费降一个量级,切点精度零损失
- **镜头切点吸附**:TransNetV2 本地检测真实镜头边界,切点自动吸附(词边界守卫绝不切掉说话)
- **商品讲解模式(带货直播切片)**:填商品词,按「试用实测 > 卖点 > 价格机制」转化逻辑选段;纯憋单拉互动段(平台判违规)明确排除
- **切片时长档**:短·10-30s / 标准·8-40s / 长·40-90s 一键切换重选段,目标时长作为硬约束进提示词
</details>

### 📝 字幕与文案:自动加字幕、发布文案一步到位

卡拉OK逐字点亮字幕直接烧进画面(词级时间戳驱动、语义断行不拦腰截断),SRT 可导出、双语可选;AI 起的爆款标题自动烧进顶部贴片,发布文案带标签生成。

<details>
<summary><b>展开细节</b>:气泡特效字幕 · 开场钩子 · 双语 · Hormozi 大字 · 违禁词 lint · AIGC 标识</summary>

- **语义断行(免 Key)**:顺着标点在真实子句处换行,长句无标点时回看结构助词断行——等价于头部项目用 LLM 插 `[br]`,但零额外调用
- **气泡特效字幕(Web 渲染引擎)**:内置 Chromium 离屏逐帧渲染 CSS 字幕层——自适应圆角气泡底、关键词渐变金字、弹性入场,libass 做不出的效果一档切换
- **开场钩子(黄金3秒)**:AI 写的悬念句自动大字烧在开头 2 秒上三分之一,淡入淡出避开主体;没写出悬念句自动不加
- **Hormozi 大字爆点字幕**:带货营销风,特大加粗、硬阴影、逐词点亮
- **双语字幕(出海一步到位)**:整句语境翻译烧成副轨,中文源自动译英;跳剪压缩时译文行同步重映射
- **SRT 字幕文件导出**:时间轴已对齐跳剪/剪口头禅后的成片,断行与烧录字幕一致
- **发布文案生成**:每条切片生成钩子风标题 + 3-6 个垂类标签 + 简介,落 `.post.txt` 与 clips.json;8 种钩子角度 × 5 类 CTA 可选
- **平台违禁词 lint**:120+ 本地规则扫标题/文案/字幕,绝对化用语/医疗宣称/导流话术发布前点名,零上传
- **AIGC 标识(合规内建)**:按《人工智能生成合成内容标识办法》一键打标——显式画面标识 + 隐式元数据标识
</details>

### 🎬 成片质量:像人剪的,不是机切的

人脸跟随智能取景(镜头级三模式)、气口跳剪、剪口头禅、响度归一 -14 LUFS、帧精确切割——制作链一步到位,每条切片出片后还有自我质检。

<details>
<summary><b>展开细节</b>:横屏转竖屏 · 去气口 · 降噪 · 质检自修复 · 智能封面 · 高潮前置</summary>

- **人脸跟随智能取景(横屏转竖屏 9:16)**:自动检测并跟随人脸(静止/平滑横移/One Euro 跟踪三模式),无人脸自动回退居中裁剪
- **去录屏UI**:手机直播录屏的状态栏/固定UI/黑边,时域方差自动检测裁除
- **气口跳剪(自动去气口)**:剪掉停顿静音并拼接,字幕时间轴同步重映射;「无词且声学静默」双重判定,笑声掌声不误删
- **剪口头禅**:嗯/呃、结巴重复自动剪除(词表刻意保守),剪了什么逐条写进 clips.json
- **响度标准化**:每条按 EBU R128 归一到 -14 LUFS 社媒标准,整批音量一致;跳剪后按拼接后音轨计算
- **一键降噪**:双高通(24dB/oct 压电流声)+ 谱减降噪进出片链,实测静音段底噪 -7.9dB、人声只动 0.2dB
- **出片自我质检 + 自我修复**:黑屏/长静音/响度/时长/切点半词复核写进 clips.json;可自愈的告警当场修好(裁边/重归一),修完重检变好才采纳
- **高潮前置(cold-open)**:最炸的钩子句自动剪到开头再接正片——完播率手法,商业工具锁在付费档;定位失败自动跳过,宁可不做不可做错
- **智能封面选帧**:自动选切片内响度最高一帧当封面(通常是情绪最高点),避开转场
- **帧精确切割**:快速定位+重编码,爆点第一秒不糊不偏;数小时 FLV/TS 直接进
- **导出可取消 + 实时进度**:ffmpeg 进度流式回报,随时一键取消,已完成切片保留
</details>

### 🧰 审阅与工作流:AI 粗剪,人终剪

导出前应用内看片微调:切片审阅台(波形时间轴拖手柄逐词调切点)、字幕安全区预览(九平台真实遮挡遮罩)、出片偏好记忆、品牌样式模板。

<details>
<summary><b>展开细节</b>:审阅台 · 安全区 · 品牌模板 · 双画幅 · 合集 · EDL · 设置页</summary>

- **切片审阅台**:应用内直接播放候选,波形时间轴拖两端手柄逐词微调(自动吸附字词边界),一键还原 AI 切点;手调过的切点导出时机器不再改人的决定
- **字幕安全区预览**:一键叠加平台 UI 遮挡遮罩(抖音/快手/B站竖屏/视频号/小红书/TikTok/Reels/Shorts + 通用并集九档,按实测数据画)
- **品牌样式模板**:主高亮色/字幕字号位置/logo 水印配一次存成预设,每条切片自动带上;用了什么写进回执
- **一键双画幅**:同批切片竖屏之外再出一版横屏(自动去标题贴片、字幕换底部布局),竖版发抖音、横版发B站一次搞定
- **精华合集一键成片**:整批切片流复制拼接成合集(秒级零损),附章节时间戳,B站/YouTube 周更形态现成
- **时间线 EDL 导出**:`timeline.edl`(CMX3600)含跳剪的每一刀,导入 DaVinci / Premiere 重链源片继续精修
- **Audiogram 音频成片**:纯音频源自动合成深色底+品牌色波形动画画面,播客也有「画面」
- **出片偏好记忆 + 标题即点即改**:开关组合自动记住;候选标题点铅笔就改,文件名/贴片/文案全跟着走
- **设置页**:模型存放位置可见可搬家(跨盘走「复制→校验→才删原件」)、导出画质三档(省空间档体积小 66%)、默认字幕样式与导出位置
- **新版本提示**:启动静默检查,有新版页头亮小徽标;断网全静默
</details>

### 🤖 批量与生态:CLI / MCP / Agent Skill

一键全托管(导入后点一个按钮全自动出片)+ 录播监听 7×24 无人值守 + Headless CLI + 本地 MCP Server——**唯一本地不上传的切片 Agent 工具链**。

<details>
<summary><b>展开细节</b>:录播监听 · CLI · MCP · Claude Code 技能 · doctor</summary>

- **录播监听(7×24 无人值守)**:盯住录播姬/OBS 输出目录,新录播落稳自动转写→找爆点→出片;「连续两轮大小不变」才算录完绝不切半截,单文件失败跳过绝不循环烧费用
- **Headless CLI**(与桌面端产物完全一致):

  ```bash
  pnpm cli transcribe 直播回放.mp4                 # 端侧逐字转写(带缓存)
  pnpm cli highlights 直播回放.mp4 --json          # AI 爆点候选,先审后剪
  pnpm cli clip 直播回放.mp4 --max-clips 10        # 全托管出片 + 质检报告
  pnpm cli doctor --download                       # 环境自检 + 预下载模型
  ```

- **本地 MCP Server**:Claude Code / Claude Desktop 注册后,一句「把这个 4 小时录播切 10 条爆点」就是完整交付;三个工具 `clip_video` / `detect_highlights` / `transcribe_video`

  ```json
  {
    "mcpServers": {
      "hotclip": {
        "command": "npx",
        "args": ["-y", "tsx", "src/mcp/server.ts"],
        "cwd": "/path/to/hotclip",
        "env": {
          "HOTCLIP_LLM_BASE_URL": "http://localhost:11434/v1",
          "HOTCLIP_LLM_MODEL": "qwen3:8b"
        }
      }
    }
  }
  ```

- **官方 Agent Skill**:把这段话直接粘给 Claude Code / Codex,Agent 会自己完成安装:

  > 请安装 HotClip 作为我的本地切片技能:`git clone https://github.com/xixihhhh/hotclip.git && cd hotclip && pnpm install`,然后把 `skills/hotclip/` 复制到我的 Agent skills 目录(Claude Code 为 `~/.claude/skills/hotclip/`),并按 `skills/hotclip/SKILL.md` 里的说明配置 LLM 环境变量。装好后用一段测试视频跑 `pnpm cli highlights` 验证。

- **clips.json 处理回执**:每条片 AI 动了什么(字幕样式/取景模式/跳剪比例/剪了几个口头禅)一目了然,可审计,矩阵管线直接取用
- **模型自带干粮也行**:默认本地免费模型;更强的爆点判断可一键接 [Atlas Cloud](https://www.atlascloud.ai)、fal.ai 或任意 OpenAI 兼容接口,或本机 Ollama 完全离线
</details>

## 最近更新

**[v0.9.4](https://github.com/xixihhhh/hotclip/releases/tag/v0.9.4)**(2026-07-31)「中文用户名不再背锅」:修复 Windows 中文用户名下转写必失败([#4](https://github.com/xixihhhh/hotclip/issues/4))——模型路径自动转 8.3 短路径、音频样本改应用侧读入;跨盘搬模型不再被误拦;模型加载失败给对症提示。

<details>
<summary><b>历史版本</b>(v0.4.3 → v0.9.3)与里程碑一览</summary>

- **[v0.9.3](https://github.com/xixihhhh/hotclip/releases/tag/v0.9.3)**(2026-07-28)「东西存哪儿、出多大,你说了算」:设置页上线([#3](https://github.com/xixihhhh/hotclip/issues/3))——模型存放位置可见可搬家、导出画质三档(省空间档小 66%)、默认字幕样式与导出位置收进设置
- **[v0.9.2](https://github.com/xixihhhh/hotclip/releases/tag/v0.9.2)**(2026-07-27)「报错说人话、界面不挤乱」:转写失败对症归因([#2](https://github.com/xixihhhh/hotclip/issues/2));出片选项条自动换行不再撑破界面;导出位置可自选([#3](https://github.com/xixihhhh/hotclip/issues/3))
- **[v0.9.1](https://github.com/xixihhhh/hotclip/releases/tag/v0.9.1)**(2026-07-24)「Windows 首启修复」:修复模型下载 100% 又从头开始的循环(Windows tar 不支持 bzip2,内置纯 JS 解压兜底);解压进度条;临时目录原子落位
- **[v0.9.0](https://github.com/xixihhhh/hotclip/releases/tag/v0.9.0)**(2026-07-24)「越用越懂你、装完就能跑」:审阅反馈回流(采用/否决自动进本地偏好档)+ `doctor` 环境自检 + 模型下载断点续传 + 发布文案角度模板(8 钩子角度×5 CTA)+ 参考爆款入口补全
- **[v0.8.0](https://github.com/xixihhhh/hotclip/releases/tag/v0.8.0)**(2026-07-20)「照着爆款切、坏片自己修」:参考视频驱动 + 出片自我修复 + 平台违禁词 lint(120+ 规则)+ Hormozi 大字字幕 + 抽帧接触表(VLM 调用 20→3)
- **[v0.7.0](https://github.com/xixihhhh/hotclip/releases/tag/v0.7.0)**(2026-07-16)「切完自检、随叫随剪」:出片自我质检 + Headless CLI 与官方 Agent Skill + 精华合集 + 高潮前置 + 一键双画幅 + 商品讲解模式
- **[v0.6.0](https://github.com/xixihhhh/hotclip/releases/tag/v0.6.0)**(2026-07-10)「看得见画面、接得上生态」:六路证据链(+视觉/表情/弹幕)+ 双语字幕 + 本地 MCP Server + 录播监听 + 发布三件套
- **[v0.5.0](https://github.com/xixihhhh/hotclip/releases/tag/v0.5.0)**(2026-07-09)「选得准、批量稳」:切片审阅台 + 镜头切点吸附 + 品牌样式模板 + 端侧两级漏斗
- **[v0.4.3](https://github.com/xixihhhh/hotclip/releases/tag/v0.4.3)**(2026-07-06)工程底座:转写本地缓存 + clips.json 处理回执

| 里程碑 | 状态 |
|---|---|
| 桌面客户端 · 本地转写三档 · AI 找爆点 · 竖屏+字幕成片 · 人脸跟随 | ✅ 已完成 |
| 说话人分离 · 气泡字幕 · 气口跳剪 · 一键全托管 · 安装包发布 | ✅ 已完成 |
| v0.5 ~ v0.9(审阅台 · MCP · 录播监听 · 质检修复 · 反馈回流 · 设置页) | ✅ 已发布 |
| 多平台发布 · 剪映草稿导出 · 英文 ASR 升级 | 🗺️ [规划中](docs/PRODUCT-PLAN.md) |

</details>

完整更新历史见 [Releases](https://github.com/xixihhhh/hotclip/releases) · 想投票决定先做哪个?到 [Discussions](https://github.com/xixihhhh/hotclip/discussions) 留言。

## 常见问题

**有什么免费的 AI 切片 / AI 剪辑软件?**
HotClip 就是——免费开源(AGPL-3.0)、本地运行的 AI 剪辑 / 视频切片工具,把长视频、直播回放一键切成竖屏短视频,无水印、无积分制、不限时长,Windows / macOS 都有安装包。

**直播回放 / 播客怎么一键剪成抖音、B站短视频?**
导入文件 → AI 转写并自动识别高光片段(可手动增删调边界)→ 一键导出竖屏 9:16 成片,自带字幕、标题贴片和封面图,直接上传抖音 / 快手 / B站 / 视频号 / 小红书。

**AI 剪辑会上传我的视频吗?需要联网吗?**
不上传。转写、字幕、切片、导出全程在你自己的电脑上离线完成。只有「AI 找爆点」这一步默认调用云端大模型(只发文字稿,用你自己的 Key),接本机 Ollama 后 100% 离线。

**能自动加字幕吗?**
能。逐字点亮的卡拉OK动态字幕直接烧进画面,也可导出 SRT 给平台原生上传;开双语字幕还能整句翻译烧成第二行。

**能自动剪掉口播里的停顿和口头禅吗?视频如何去气口?**
能。「剪气口」自动删掉说话间的静音停顿,「剪口头禅」剪掉嗯/呃与结巴重复——剪了什么逐条写进 clips.json,你始终知道 AI 动了哪里。

**HotClip 和剪映 / OpusClip / Klap 这类工具的区别?**
最大区别是素材不出你的电脑:OpusClip 等 SaaS 必须上传云端、按源视频分钟扣积分(积分月底清零),免费档带水印;剪映的智能切片等核心能力在会员档。HotClip 开源免费、本地处理、无水印、不限时长,AI 切点附理由可审计。详见上方[对比表](#和-opusclip剪映智能切片的区别)。

**支持中文视频吗?方言、粤语呢?**
支持且是强项。中文识别走专用引擎(SenseVoice/Paraformer/FireRedASR2),准确率显著高于通用模型;方言、粤语、中英混说都覆盖,界面、字幕、prompt 都针对中文内容做了适配。

**需要显卡吗?配置要求高吗?**
不需要。本地转写用 int8 量化小模型,普通 CPU 就能跑;找爆点的大模型在云端(或你本机的 Ollama)。

**可以切别人的直播吗?直播切片如何申请授权?**
HotClip 面向你自己的内容或已获授权的切片。切别人的直播请先拿到授权(如各平台/公会的主播切片授权计划);未经授权的影视/直播搬运不受支持,也不欢迎。

**首次使用,语音模型下载到 100% 又从头开始怎么办?**
升级到 [v0.9.1](https://github.com/xixihhhh/hotclip/releases) 或更新版本即可,老版本的 Windows 解压 bug 已彻底修复;旧版已下载的字节还会自动续传。

## 开发者

```bash
git clone https://github.com/xixihhhh/hotclip.git
cd hotclip
pnpm install
pnpm dev        # 启动桌面应用(开发模式)
pnpm test       # 跑单元测试
```

**技术栈**:Electron + React 19 + TypeScript + Tailwind 4 · ffmpeg(打包内置)· sherpa-onnx 本地转写 + 说话人分离 · libass 卡拉OK字幕 + 离屏 Chromium 气泡字幕引擎 · LLM 爆点检测(Atlas Cloud / Ollama / 任意 OpenAI 兼容接口,BYO Key)

<details>
<summary><b>站在这些开源项目的肩膀上</b></summary>

| 项目 | 在 HotClip 中的角色 |
|---|---|
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | 本地语音识别运行时(纯 CPU 可跑) |
| [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) / [FunASR](https://github.com/modelscope/FunASR) | 五语种快速转写 / Paraformer 中文转写与标点 |
| [FireRedASR](https://github.com/FireRedTeam/FireRedASR) | 最高精度档:普通话/方言/中英混说 |
| [pyannote-audio](https://github.com/pyannote/pyannote-audio) + [3D-Speaker](https://github.com/modelscope/3D-Speaker) | 说话人分离(本地零上传) |
| [FFmpeg](https://ffmpeg.org/) + [libass](https://github.com/libass/libass) | 帧精确切割 / 字幕烧录 |
| [onnxruntime](https://github.com/microsoft/onnxruntime) | 端侧模型推理 |

</details>

## 授权与边界

- 代码:**AGPL-3.0-only**
- HotClip 面向**你自己的内容**或**已获授权的切片**(如主播切片授权计划)。请遵守各平台二创与授权规则——未经授权的影视/直播搬运不受支持,也不欢迎。

## 社区与同作者项目

- 🐛 [提 Bug / 安装求助](https://github.com/xixihhhh/hotclip/issues) · 💡 [功能建议与 Roadmap](https://github.com/xixihhhh/hotclip/discussions)
- 🔨 **[ClipForge](https://github.com/xixihhhh/clipforge)** — 开源 AI 带货短视频神器:上传一张商品图,AI 提炼卖点、写脚本、配画面配音字幕,一键产出卖货视频。**HotClip 把长视频切成爆款,ClipForge 从一张图造出短视频**,做电商/带货的朋友可以配着用

[![Star History Chart](https://api.star-history.com/svg?repos=xixihhhh/hotclip&type=Date)](https://star-history.com/#xixihhhh/hotclip&Date)

<div align="center">

**⭐ 觉得有用就点个 Star——Star + Watch 第一时间收到新版本通知,每颗星都是让更多人不用再给积分制付费的一票。**

</div>
