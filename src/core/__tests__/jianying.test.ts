/**
 * 剪映草稿导出:draft_content.json 结构与 pyJianYingDraft 5.9 口径对齐。
 */
import { describe, it, expect } from "vitest";
import { buildDraftContent, buildDraftMetaInfo } from "../jianying";

/** 递增 id 生成器:测试可复现。 */
const seqIds = (): (() => string) => {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
};

const INPUT = {
  sourcePath: "/v/我的直播回放.mp4",
  sourceName: "我的直播回放.mp4",
  sourceDurationSec: 5427.5,
  width: 1920,
  height: 1080,
  fps: 30,
  clip: {
    title: "测试切片",
    segments: [
      { startSec: 100.2, endSec: 112.8 },
      { startSec: 115.0, endSec: 120.5 },
    ],
  },
};

describe("buildDraftContent", () => {
  const content = buildDraftContent(INPUT, seqIds()) as Record<string, any>;

  it("画布=原画幅,时长=保留段总和(微秒),单视频轨", () => {
    expect(content.canvas_config).toEqual({ height: 1080, ratio: "original", width: 1920 });
    expect(content.duration).toBe(Math.round(12.6e6) + Math.round(5.5e6));
    expect(content.tracks).toHaveLength(1);
    expect(content.tracks[0].type).toBe("video");
  });

  it("片段 source 反链源片区间,target 连续拼接,每段独立可拖", () => {
    const segs = content.tracks[0].segments;
    expect(segs).toHaveLength(2);
    expect(segs[0].source_timerange).toEqual({ start: 100_200_000, duration: 12_600_000 });
    expect(segs[0].target_timerange.start).toBe(0);
    expect(segs[1].source_timerange.start).toBe(115_000_000);
    expect(segs[1].target_timerange.start).toBe(segs[0].target_timerange.duration);
    expect(segs[0].speed).toBe(1.0);
    expect(segs[0].visible).toBe(true);
    expect(segs[0].render_index).toBe(0);
  });

  it("素材反链源片绝对路径,时长为源片全长;speed 素材与片段一一对应且被引用", () => {
    const mats = content.materials;
    expect(mats.videos).toHaveLength(1);
    expect(mats.videos[0].path).toBe("/v/我的直播回放.mp4");
    expect(mats.videos[0].duration).toBe(5_427_500_000);
    expect(mats.videos[0].type).toBe("video");
    expect(mats.speeds).toHaveLength(2);
    const speedIds = mats.speeds.map((s: { id: string }) => s.id);
    const segs = content.tracks[0].segments;
    expect(segs[0].extra_material_refs).toEqual([speedIds[0]]);
    expect(segs[1].extra_material_refs).toEqual([speedIds[1]]);
    // 片段都指向同一份素材
    expect(new Set(segs.map((s: { material_id: string }) => s.material_id)).size).toBe(1);
    expect(segs[0].material_id).toBe(mats.videos[0].id);
  });

  it("materials 空分类齐全(缺键剪映按损坏草稿处理);平台标 5.9 模板", () => {
    for (const key of ["audios", "texts", "transitions", "canvases", "effects", "masks", "stickers"]) {
      expect(Array.isArray(content.materials[key])).toBe(true);
    }
    expect(content.platform.app_version).toBe("5.9.0");
    expect(content.version).toBe(360000);
    expect(content.new_version).toBe("110.0.0");
  });

  it("零长/负长的段被过滤;素材时长兜底不小于片段截取终点", () => {
    const weird = buildDraftContent(
      {
        ...INPUT,
        sourceDurationSec: 0, // 容器时长未知
        clip: { title: "t", segments: [{ startSec: 5, endSec: 5 }, { startSec: 10, endSec: 20 }] },
      },
      seqIds()
    ) as Record<string, any>;
    expect(weird.tracks[0].segments).toHaveLength(1);
    expect(weird.materials.videos[0].duration).toBeGreaterThanOrEqual(20_000_000);
  });

  it("同一 id 生成器序列 → 输出可复现", () => {
    const a = JSON.stringify(buildDraftContent(INPUT, seqIds()));
    const b = JSON.stringify(buildDraftContent(INPUT, seqIds()));
    expect(a).toBe(b);
  });
});

describe("buildDraftMetaInfo", () => {
  it("draft_id 为大写 UUID;draft_materials 七个分类槽位", () => {
    const meta = buildDraftMetaInfo(seqIds()) as Record<string, any>;
    expect(meta.draft_id).toMatch(/^[0-9A-F-]{36}$/);
    expect(meta.draft_materials.map((m: { type: number }) => m.type)).toEqual([0, 1, 2, 3, 6, 7, 8]);
    expect(meta.draft_fold_path).toBe("");
  });
});
