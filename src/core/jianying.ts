/**
 * 剪映草稿导出(v0.14):把 AI 定的切点——含跳剪在片内的每一段保留区间——
 * 生成剪映专业版草稿文件夹(draft_content.json + draft_meta_info.json),
 * 整个文件夹拷进剪映草稿目录即可打开精修。EDL 面向 DaVinci/Premiere,
 * 而中文创作者的主力剪辑器是剪映、且剪映不认 EDL——这是「AI 粗剪 →
 * 人精修」工作流在国民级剪辑器上的落地。
 *
 * 格式口径:pyJianYingDraft(GuanYixuan)的明文 draft_content 结构,
 * 模板标 5.9(剪映 6/7+ 能打开明文生成的草稿;新版的草稿加密只影响
 * 「读取既有草稿当模板」,与生成无关)。素材引用源片绝对路径,换机器
 * 打开时剪映会提示重新链接媒体——与 EDL 同语义。时间单位微秒。
 * 纯函数(id 生成可注入以便单测),文件写入由 export.ts 负责。
 */
import { randomUUID } from "crypto";
import type { EdlClip } from "./edl";

/** 注入式 id 生成器(默认 uuid v4);hex 形态供轨道/片段/素材 id 用。 */
export type IdGen = () => string;
const defaultIdGen: IdGen = () => randomUUID();
const hexOf = (id: string): string => id.replace(/-/g, "");

export interface DraftContentInput {
  /** 源片绝对路径(素材直接反链源片,媒体不复制)。 */
  sourcePath: string;
  /** 源文件名(素材面板显示名)。 */
  sourceName: string;
  /** 源片总时长(秒)——素材对象的时长上限。 */
  sourceDurationSec: number;
  /** 源片画幅(草稿画布 = 原画幅,「回源片精修」与 EDL 同定位)。 */
  width: number;
  height: number;
  /** 草稿帧率(取整;剪映内部用它做时间轴吸附)。 */
  fps: number;
  /** 该切片的保留区间(源片绝对秒,跳剪时一条多段,按序拼接)。 */
  clip: EdlClip;
}

const SEC_US = 1_000_000;
const toUs = (sec: number): number => Math.round(sec * SEC_US);

/**
 * 组装一条切片的 draft_content.json 对象:一条视频轨,保留区间按序
 * 排上时间轴(source_timerange 反链源片,target_timerange 连续拼接),
 * 跳剪的每一刀都是时间轴上可拖的独立片段。
 */
export function buildDraftContent(input: DraftContentInput, newId: IdGen = defaultIdGen): Record<string, unknown> {
  const { sourcePath, sourceName, sourceDurationSec, width, height, fps, clip } = input;
  const segs = clip.segments.filter((s) => s.endSec > s.startSec);
  const materialId = hexOf(newId());
  // 素材时长必须 ≥ 任何片段的截取终点,否则剪映按「越界素材」拒载
  const maxEndUs = segs.reduce((m, s) => Math.max(m, toUs(s.endSec)), 0);
  const materialDurationUs = Math.max(toUs(sourceDurationSec), maxEndUs);

  const speeds: Array<Record<string, unknown>> = [];
  const segments: Array<Record<string, unknown>> = [];
  let targetUs = 0;
  for (const seg of segs) {
    const durUs = toUs(seg.endSec) - toUs(seg.startSec);
    const speedId = hexOf(newId());
    speeds.push({ curve_speed: null, id: speedId, mode: 0, speed: 1.0, type: "speed" });
    segments.push({
      enable_adjust: true,
      enable_color_correct_adjust: false,
      enable_color_curves: true,
      enable_color_match_adjust: false,
      enable_color_wheels: true,
      enable_lut: true,
      enable_smart_color_adjust: false,
      last_nonzero_volume: 1.0,
      reverse: false,
      track_attribute: 0,
      track_render_index: 0,
      visible: true,
      id: hexOf(newId()),
      material_id: materialId,
      target_timerange: { start: targetUs, duration: durUs },
      common_keyframes: [],
      keyframe_refs: [],
      source_timerange: { start: toUs(seg.startSec), duration: durUs },
      speed: 1.0,
      volume: 1.0,
      extra_material_refs: [speedId],
      is_tone_modify: false,
      clip: {
        alpha: 1.0,
        flip: { horizontal: false, vertical: false },
        rotation: 0.0,
        scale: { x: 1.0, y: 1.0 },
        transform: { x: 0.0, y: 0.0 },
      },
      uniform_scale: { on: true, value: 1.0 },
      hdr_settings: { intensity: 1.0, mode: 1, nits: 1000 },
      render_index: 0,
    });
    targetUs += durUs;
  }

  const videoMaterial = {
    audio_fade: null,
    category_id: "",
    category_name: "local",
    check_flag: 63487,
    crop: {
      upper_left_x: 0.0, upper_left_y: 0.0, upper_right_x: 1.0, upper_right_y: 0.0,
      lower_left_x: 0.0, lower_left_y: 1.0, lower_right_x: 1.0, lower_right_y: 1.0,
    },
    crop_ratio: "free",
    crop_scale: 1.0,
    duration: materialDurationUs,
    height,
    id: materialId,
    local_material_id: "",
    material_id: materialId,
    material_name: sourceName,
    media_path: "",
    path: sourcePath,
    type: "video",
    width,
  };

  // 骨架与 pyJianYingDraft 的 5.9 模板逐字段一致(materials 的空数组分类
  // 必须齐全,剪映按键取值,缺键会视为损坏草稿)
  return {
    canvas_config: { height, ratio: "original", width },
    color_space: 0,
    config: {
      adjust_max_index: 1,
      attachment_info: [],
      combination_max_index: 1,
      export_range: null,
      extract_audio_last_index: 1,
      lyrics_recognition_id: "",
      lyrics_sync: true,
      lyrics_taskinfo: [],
      maintrack_adsorb: true,
      material_save_mode: 0,
      multi_language_current: "none",
      multi_language_list: [],
      multi_language_main: "none",
      multi_language_mode: "none",
      original_sound_last_index: 1,
      record_audio_last_index: 1,
      sticker_max_index: 1,
      subtitle_keywords_config: null,
      subtitle_recognition_id: "",
      subtitle_sync: true,
      subtitle_taskinfo: [],
      system_font_list: [],
      video_mute: false,
      zoom_info_params: null,
    },
    cover: null,
    create_time: 0,
    duration: targetUs,
    extra_info: null,
    fps: fps,
    free_render_index_mode_on: false,
    group_container: null,
    id: newId().toUpperCase(),
    keyframe_graph_list: [],
    keyframes: {
      adjusts: [], audios: [], effects: [], filters: [],
      handwrites: [], stickers: [], texts: [], videos: [],
    },
    last_modified_platform: { app_id: 3704, app_source: "lv", app_version: "5.9.0", os: "windows" },
    platform: { app_id: 3704, app_source: "lv", app_version: "5.9.0", os: "windows" },
    materials: {
      ai_translates: [], audio_balances: [], audio_effects: [], audio_fades: [],
      audio_track_indexes: [], audios: [], beats: [], canvases: [], chromas: [],
      color_curves: [], digital_humans: [], drafts: [], effects: [], flowers: [],
      green_screens: [], handwrites: [], hsl: [], images: [], log_color_wheels: [],
      loudnesses: [], manual_deformations: [], masks: [], material_animations: [],
      material_colors: [], multi_language_refs: [], placeholders: [], plugin_effects: [],
      primary_color_wheels: [], realtime_denoises: [], shapes: [], smart_crops: [],
      smart_relights: [], sound_channel_mappings: [], speeds, stickers: [],
      tail_leaders: [], text_templates: [], texts: [], time_marks: [], transitions: [],
      video_effects: [], video_trackings: [], videos: [videoMaterial],
      vocal_beautifys: [], vocal_separations: [],
    },
    mutable_config: null,
    name: "",
    new_version: "110.0.0",
    relationships: [],
    render_index_track_mode_on: false,
    retouch_cover: null,
    source: "default",
    static_cover_image_path: "",
    time_marks: null,
    tracks: [
      {
        attribute: 0,
        flag: 0,
        id: hexOf(newId()),
        is_default_name: true,
        name: "",
        segments,
        type: "video",
      },
    ],
    update_time: 0,
    version: 360000,
  };
}

/** draft_meta_info.json:逐字段抄模板,只换 draft_id(剪映打开时自补其余)。 */
export function buildDraftMetaInfo(newId: IdGen = defaultIdGen): Record<string, unknown> {
  return {
    cloud_package_completed_time: "",
    draft_cloud_capcut_purchase_info: "",
    draft_cloud_last_action_download: false,
    draft_cloud_materials: [],
    draft_cloud_purchase_info: "",
    draft_cloud_template_id: "",
    draft_cloud_tutorial_info: "",
    draft_cloud_videocut_purchase_info: "",
    draft_cover: "",
    draft_deeplink_url: "",
    draft_enterprise_info: {
      draft_enterprise_extra: "",
      draft_enterprise_id: "",
      draft_enterprise_name: "",
      enterprise_material: [],
    },
    draft_fold_path: "",
    draft_id: newId().toUpperCase(),
    draft_is_ai_packaging_used: false,
    draft_is_ai_shorts: false,
    draft_is_ai_translate: false,
    draft_is_article_video_draft: false,
    draft_is_from_deeplink: "false",
    draft_is_invisible: false,
    draft_materials: [0, 1, 2, 3, 6, 7, 8].map((type) => ({ type, value: [] })),
    draft_materials_copied_info: [],
    draft_name: "",
    draft_new_version: "",
    draft_removable_storage_device: "",
    draft_root_path: "",
    draft_segment_extra_info: [],
    draft_type: "",
    tm_draft_cloud_completed: "",
    tm_draft_cloud_modified: 0,
    tm_draft_removed: 0,
    tm_duration: 0,
  };
}
