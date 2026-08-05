/**
 * 平台发布包:规格表口径、封面裁切滤镜、文案按平台上限适配、打包落盘。
 * 切片手同一批片发 N 个平台,每平台规格不同——适配错了(标题超限/封面
 * 画幅不对)发布时才发现,等于白打包。
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PLATFORM_SPECS, platformSpec, validPlatformIds } from "../../shared/platform-specs";
import { coverFilter, adaptPost, buildPublishPacks, PACK_DIR_NAME } from "../publish-pack";
import type { PublishCopy } from "../publish";

const copy: PublishCopy = {
  title: "这个价格他说绝对绝对不会降,三分钟后自己当场打脸了", // 25 字,超小红书 20 字上限
  hashtags: ["#直播切片", "#带货", "#翻车", "#名场面", "#搞笑", "#打脸", "#多出来的"],
  description: "前面话说得有多满,后面脸就有多疼。",
  cta: "你见过更快的打脸吗?评论区聊聊",
};

describe("platform-specs", () => {
  it("规格表与安全区平台对齐:抖音/快手/B站/视频号/小红书/TikTok/Shorts/Reels", () => {
    const ids = PLATFORM_SPECS.map((p) => p.id);
    for (const id of ["douyin", "kuaishou", "bilibili", "channels", "xiaohongshu", "tiktok", "shorts", "reels"]) {
      expect(ids).toContain(id);
    }
  });

  it("关键硬限制正确:小红书标题20字、B站80字、Shorts 100字符", () => {
    expect(platformSpec("xiaohongshu")!.titleMax).toBe(20);
    expect(platformSpec("bilibili")!.titleMax).toBe(80);
    expect(platformSpec("shorts")!.titleMax).toBe(100);
  });

  it("封面画幅:小红书3:4、B站16:10、竖屏平台9:16", () => {
    const xhs = platformSpec("xiaohongshu")!.cover;
    expect(xhs.w / xhs.h).toBeCloseTo(3 / 4, 3);
    const bili = platformSpec("bilibili")!.cover;
    expect(bili.w / bili.h).toBeCloseTo(16 / 10, 2);
    const dy = platformSpec("douyin")!.cover;
    expect(dy.w / dy.h).toBeCloseTo(9 / 16, 3);
  });

  it("validPlatformIds 过滤未知 id、去重、保序", () => {
    expect(validPlatformIds(["xiaohongshu", "瞎编的", "douyin", "xiaohongshu"])).toEqual(["xiaohongshu", "douyin"]);
    expect(validPlatformIds([])).toEqual([]);
  });
});

describe("coverFilter", () => {
  it("裁切表达式对任意输入尺寸成立且纵向上偏(不把人头裁掉)", () => {
    const f = coverFilter(platformSpec("xiaohongshu")!);
    expect(f).toContain("min(iw,ih*");
    expect(f).toContain("(ih-oh)*0.33"); // 上偏 1/3,不是居中
    expect(f).toContain("scale=1080:1440");
  });
});

describe("adaptPost", () => {
  it("小红书:标题按码点截到20字并标记,话题截到上限", () => {
    const out = adaptPost("片名", copy, platformSpec("xiaohongshu")!);
    expect(Array.from(out.title)).toHaveLength(20);
    expect(out.titleTruncated).toBe(true);
    expect(out.hashtags.length).toBeLessThanOrEqual(platformSpec("xiaohongshu")!.tagsMax);
    expect(out.text).toContain(out.title);
    expect(out.text).toContain("评论区聊聊");
  });

  it("B站:同一份文案 80 字内不截断", () => {
    const out = adaptPost("片名", copy, platformSpec("bilibili")!);
    expect(out.titleTruncated).toBe(false);
    expect(out.title).toBe(copy.title);
  });

  it("emoji 不切半:代理对按字符数截", () => {
    const emojiCopy = { ...copy, title: "😀".repeat(30) };
    const out = adaptPost("片名", emojiCopy, platformSpec("xiaohongshu")!);
    expect(Array.from(out.title)).toHaveLength(20);
    expect(out.title.includes("�")).toBe(false);
  });

  it("没有发布文案时用切片标题兜底,不产出空标题", () => {
    const out = adaptPost("兜底的切片标题", undefined, platformSpec("douyin")!);
    expect(out.title).toBe("兜底的切片标题");
    expect(out.hashtags).toEqual([]);
  });
});

describe("buildPublishPacks", () => {
  async function setup(): Promise<{ dir: string; mp4: string; jpg: string }> {
    const dir = await mkdtemp(join(tmpdir(), "hotclip-pack-"));
    const mp4 = join(dir, "01-测试片.mp4");
    const jpg = join(dir, "01-测试片.jpg");
    await writeFile(mp4, "fake-video");
    await writeFile(jpg, "fake-cover");
    return { dir, mp4, jpg };
  }

  it("每平台一个文件夹:视频硬链+封面+文案+manifest 齐套", async () => {
    const { dir, mp4, jpg } = await setup();
    const summaries = await buildPublishPacks(
      dir,
      [{ file: mp4, coverFile: jpg, title: "测试片", publish: copy }],
      ["xiaohongshu", "douyin"],
      async (_src, dest) => {
        await writeFile(dest, "adapted-cover"); // 模拟 ffmpeg 裁切
        return true;
      }
    );
    expect(summaries).toHaveLength(2);
    const xhsDir = join(dir, PACK_DIR_NAME, "小红书");
    const files = await readdir(xhsDir);
    expect(files).toContain("01-测试片.mp4");
    expect(files).toContain("01-测试片.jpg");
    expect(files).toContain("01-测试片.post.txt");
    expect(files).toContain("manifest.json");
    // 硬链:同一份数据,不占双份磁盘(inode 相同)
    const [a, b] = await Promise.all([stat(mp4), stat(join(xhsDir, "01-测试片.mp4"))]);
    expect(a.ino).toBe(b.ino);
    // manifest 记录截断:小红书标题超 20 字
    const manifest = JSON.parse(await readFile(join(xhsDir, "manifest.json"), "utf8"));
    expect(manifest.platform).toBe("xiaohongshu");
    expect(manifest.clips[0].titleTruncated).toBe(true);
    expect(summaries.find((s) => s.platform === "xiaohongshu")!.truncatedTitles).toBe(1);
  });

  it("封面裁切失败只是没封面,视频与文案照常落位", async () => {
    const { dir, mp4, jpg } = await setup();
    const summaries = await buildPublishPacks(
      dir,
      [{ file: mp4, coverFile: jpg, title: "测试片", publish: copy }],
      ["douyin"],
      async () => false // 裁切全部失败
    );
    expect(summaries).toHaveLength(1);
    const files = await readdir(join(dir, PACK_DIR_NAME, "抖音"));
    expect(files).toContain("01-测试片.mp4");
    expect(files).not.toContain("01-测试片.jpg");
    const manifest = JSON.parse(await readFile(join(dir, PACK_DIR_NAME, "抖音", "manifest.json"), "utf8"));
    expect(manifest.clips[0].cover).toBeNull();
  });

  it("未知平台 id 被过滤,全部未知时不产出任何文件夹", async () => {
    const { dir, mp4 } = await setup();
    const summaries = await buildPublishPacks(dir, [{ file: mp4, title: "t" }], ["不存在的平台"], async () => true);
    expect(summaries).toEqual([]);
  });

  it("重复打包(再导出一次)不炸:已存在的文件被替换", async () => {
    const { dir, mp4, jpg } = await setup();
    const run = (): Promise<unknown> =>
      buildPublishPacks(dir, [{ file: mp4, coverFile: jpg, title: "测试片", publish: copy }], ["douyin"], async (_s, d) => {
        await writeFile(d, "c");
        return true;
      });
    await run();
    await expect(run()).resolves.toBeTruthy();
  });
});
