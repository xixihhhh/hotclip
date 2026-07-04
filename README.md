# HotClip 爆款切片 — 长视频/直播回放,一键切出爆款竖屏短视频 | AI Clip Generator: Long Video to Viral Shorts

> **把几个小时的长视频,筛成能上热门的短视频。** 播客 · 直播回放 · 课程 · Vlog → AI 自动找爆点(金句/冲突/高能瞬间) → 竖屏 9:16 重构 + 逐字动态字幕 → 直接发**抖音 / 快手 / B站 / 视频号 / 小红书 / TikTok / Reels / Shorts**。
>
> **本地运行 · 真免费 · 无水印 · 不限时长 · 素材不出你的电脑。** 提供 Windows / macOS 桌面客户端,不会代码也能用。

> **Pan hours of long-form video for gold.** Podcasts · livestream replays · lectures · vlogs → AI highlight detection (quotables, conflict, peak moments) → 9:16 auto-reframe + word-level animated captions → ready to post on TikTok / Reels / Shorts / Douyin / Bilibili.
>
> **Local-first · actually free · no watermark · no length caps · your footage never leaves your machine.** Ships as a beginner-friendly Windows / macOS desktop app.

<p align="right"><strong>中文</strong> · English (bilingual README)</p>

---

## 🚧 项目状态 / Status

**开发中(Work in Progress)**——桌面客户端骨架已就绪,切片管线按里程碑推进,先 Watch/Star 蹲首个可用版本:

| 里程碑 Milestone | 状态 Status |
|---|---|
| 桌面客户端骨架(Electron,中英双语,导入+媒体探测) | ✅ 已完成 |
| M2 本地转写(whisper.cpp;中文走 SenseVoice/Paraformer 更准) | 🔨 进行中 |
| M3 AI 找爆点(LLM 逐字选段,不让 LLM 猜时间戳 → 切点更准) | ⏳ 排队 |
| M4 竖屏重构(人脸追踪)+ 逐字卡拉OK字幕 | ⏳ 排队 |
| M5 平台规格导出 + 剪映草稿导出 + 安装包发布 | ⏳ 排队 |
| Web 平台版 · 更多界面语言 | 🗺️ 规划中 |

## 为什么做 HotClip / Why

市面上的 AI 切片工具,要么**按分钟扣积分**(一期 2 小时播客烧光整月额度),要么**必须上传云端**(未发布的素材/客户内容不敢传),要么切点稀烂(句子切一半、没上下文),要么**中文支持名不副实**。开源侧则几乎全是命令行/自部署,小白装不起来。

HotClip 的答案:

- 🖥️ **双击就能用**:Windows / macOS 安装包,不用 Python、不用 Docker、不用命令行
- 🔒 **本地优先**:转写、找爆点、切片全在你电脑上跑,素材不上传
- 🆓 **真免费**:开源 AGPL-3.0,无积分制、无水印、不限视频时长
- 🎯 **切点准**:LLM 只负责«挑哪段»,时间戳由逐字转写反向对齐——不让 AI 猜时间
- 🇨🇳 **中文原生**:中文语音识别走专门引擎(比通用模型准一倍),界面中英双语,导出直通国内平台规格 + 剪映草稿
- 🤖 **模型自带干粮也行**:默认本地免费模型;要更强的爆点判断,可一键接 [Atlas Cloud](https://www.atlascloud.ai)(一个 Key 用齐中外主流大模型)、fal.ai 或任意 OpenAI 兼容接口

Every commercial clipper meters your source minutes, forces cloud uploads, or botches clip boundaries; every open-source one is CLI/Docker-only. HotClip is the missing piece: an installable, local-first, bilingual desktop clipper with accurate text-aligned cuts — bring your own AI provider (Atlas Cloud recommended, fal.ai and any OpenAI-compatible endpoint supported).

## 功能规划 / Planned Features

- **AI 找爆点**:病毒度打分(钩子/情绪峰值/金句/实用价值),每条切片附推荐理由与建议标题
- **竖屏重构**:16:9 → 9:16 人脸追踪居中,无人脸场景智能裁切
- **逐字动态字幕**:卡拉OK逐字高亮 / 大字关键词 / 极简白字,3 种预设
- **直播回放友好**:数小时 FLV/TS 录像直接进,切片工作室不用再一帧帧拖进度条
- **平台规格导出**:1080×1920 H.264,抖音/快手/B站/视频号/小红书/TikTok 安全区适配
- **剪映草稿导出**:切完直接进剪映精修,工作流无断层
- **合规内建**:AIGC 标识(显式+隐式,对齐 2025-09 生效的国家标识办法);仅面向**自有内容与已授权切片**,不做搬运工具

## 快速开始 / Quick Start

> 安装包随 M5 里程碑发布(Windows exe + 绿色版 zip + macOS dmg,国内提供网盘镜像)。开发者现在就可以跑:

```bash
git clone https://github.com/xixihhhh/hotclip.git
cd hotclip
pnpm install
pnpm dev        # 启动桌面应用(开发模式)
pnpm test       # 跑单元测试
```

## 技术栈 / Tech Stack

Electron + React + TypeScript + Tailwind · ffmpeg(打包内置,无需自装)· whisper.cpp / sherpa-onnx 本地转写 · ONNX 人脸追踪 · libass 逐字字幕 · LLM 爆点检测(本地 Ollama 或云端 BYO Key)

## 常见问题 / FAQ

**HotClip 是免费的吗?/ Is it free?**
是。开源(AGPL-3.0)、本地运行、无水印、无积分制。可选的云端大模型按你自己的 Key 计费。Yes — open source, local, no watermark, no credits. Optional cloud LLMs bill your own key.

**怎么把播客/直播回放变成短视频?/ How do I turn a podcast or livestream replay into shorts?**
导入文件 → AI 转写并标出爆点(可手动增删调边界)→ 一键导出竖屏成片。Import → AI transcribes & flags highlights (fully editable) → export vertical clips.

**支持中文视频吗?/ Does it work for Chinese video?**
中文是一等公民:中文识别走 SenseVoice/Paraformer 类专用引擎,准确率显著高于通用模型;界面、字幕、导出规格均为中文原生。Chinese is first-class, with a dedicated zh ASR engine.

**需要显卡吗?/ Do I need a GPU?**
不强制。低配机器自动换小模型并给出真实耗时预估;也可一键切云端转写。No — weaker machines auto-downshift models with honest ETA, or offload to cloud.

## 授权与边界 / License & Boundaries

- 代码:**AGPL-3.0-only**
- HotClip 面向**你自己的内容**或**已获授权的切片**(如主播切片授权计划)。请遵守各平台二创与授权规则——未经授权的影视/直播搬运不受支持,也不欢迎。

---

**⭐ 觉得有用就点个 Star——首个安装包发布时你会第一时间看到。 / Star to catch the first release.**
