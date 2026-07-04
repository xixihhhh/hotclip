/**
 * 中文 — source-of-truth locale (domestic-first project).
 * Namespace → key → text. Adding a new language = copy this file's shape.
 */
export const zh = {
  common: {
    appName: "HotClip 爆款切片",
    tagline: "长视频 · 直播回放,一键切出爆款竖屏短视频",
    loading: "加载中…",
    cancel: "取消",
    confirm: "确定",
    back: "返回",
    next: "下一步",
    language: "语言",
  },
  home: {
    stepImport: "导入视频",
    stepHighlights: "挑爆点",
    stepExport: "出片",
    importTitle: "把长视频丢进来",
    importDesc: "播客 · 直播回放 · 课程 · Vlog——支持 MP4 / MKV / MOV / FLV,也支持纯音频",
    importButton: "选择视频文件",
    importDrop: "或把文件拖到这里",
    importHint: "文件不会上传,全部在你自己的电脑上处理",
    probing: "正在读取视频信息…",
    probeFailed: "无法读取这个文件,请确认它是有效的音视频文件",
    fileInfo: "文件信息",
    duration: "时长",
    resolution: "分辨率",
    framerate: "帧率",
    codec: "编码",
    audioOnly: "纯音频",
    comingSoon: "转写与爆点检测开发中——敬请期待",
    featLocalTitle: "本地处理",
    featLocalDesc: "素材不出你的电脑,隐私安全",
    featFreeTitle: "真免费",
    featFreeDesc: "无积分制、无水印、不限时长",
    featAiTitle: "AI 找爆点",
    featAiDesc: "自动定位金句、冲突、高能瞬间",
  },
} as const;
