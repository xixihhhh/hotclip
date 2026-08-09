/**
 * 平台发布包:导出完成后,把成片按平台规格整理成「拿起来就能发」的文件夹——
 * `发布包/<平台>/` 下每条切片齐套三件:视频(硬链,不占双份磁盘)、按平台
 * 画幅裁切的封面(小红书 3:4、B站 16:10、视频号 6:7……)、按平台上限适配
 * 的文案(.post.txt,标题截断线/话题数各按规格表来),外加 manifest.json
 * 记录适配了什么。
 *
 * 切片手的真实流程是同一批片发 N 个平台,每个平台规格都不一样——这一步
 * 原本要在剪映/PS 里手工重复 N 遍。fail-open:打包任何一步失败都只是
 * 少一件产物,绝不拖垮已完成的导出。
 *
 * 纯函数(封面滤镜/文案适配)可单测;文件系统与 ffmpeg 由调用方注入/自理。
 */
import { copyFile, link, mkdir, rm, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { platformSpec, validPlatformIds, type PlatformSpec } from "../shared/platform-specs";
import type { PublishCopy } from "./publish";

/** 平台名 → 文件夹名(与 export.ts 的 sanitizeFilename 同规则;不引 export 避免循环依赖)。 */
function safeDirName(name: string, fallback: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N} \-_]/gu, "").replace(/\s+/g, " ").trim().slice(0, 60);
  return cleaned || fallback;
}

/** 发布包根目录名(落在导出目录下)。 */
export const PACK_DIR_NAME = "发布包";

/** 打包输入:一条已导出的成片。 */
export interface PackClipInput {
  /** 成片 mp4 绝对路径。 */
  file: string;
  /** 封面 jpg 绝对路径(封面抓取失败时缺省)。 */
  coverFile?: string;
  /** 切片标题(没有发布文案时的标题兜底)。 */
  title: string;
  /** 发布文案(标题/话题/简介);缺省时只写标题。 */
  publish?: PublishCopy;
}

/** 单平台打包结果(进 clips.json 回执)。 */
export interface PackSummary {
  platform: string;
  name: string;
  dir: string;
  clipCount: number;
  /** 标题超平台上限被截断的条数(manifest 里逐条可查)。 */
  truncatedTitles: number;
}

/** 封面适配注入点:src 裁切/缩放到平台画幅写到 dest,成败返回布尔。 */
export type AdaptCoverFn = (src: string, dest: string, spec: PlatformSpec) => Promise<boolean>;

/**
 * 平台封面的 ffmpeg 滤镜:先裁到目标画幅(横向居中、纵向上偏 1/3——主体
 * 和人脸通常偏上,居中裁会把头切掉),再缩放到平台推荐像素。
 * 表达式对任意输入尺寸成立,竖屏/横屏/audiogram 封面都不用先探测尺寸。
 */
export function coverFilter(spec: PlatformSpec): string {
  const aspect = (spec.cover.w / spec.cover.h).toFixed(6);
  return [
    `crop='min(iw,ih*${aspect})':'min(ih,iw/${aspect})':'(iw-ow)/2':'(ih-oh)*0.33'`,
    `scale=${spec.cover.w}:${spec.cover.h}`,
  ].join(",");
}

/** 文案适配结果。 */
export interface AdaptedPost {
  /** .post.txt 全文(标题+话题+简介,直接全选复制)。 */
  text: string;
  /** 适配后的标题(截断按字符不按字节,emoji 不会切半)。 */
  title: string;
  /** 标题是否被平台上限截断。 */
  titleTruncated: boolean;
  /** 适配后的话题(数量按平台上限截取)。 */
  hashtags: string[];
}

/**
 * 把发布文案适配到平台上限:标题截断到 titleMax(小红书 20 字是硬限制,
 * 抖音 55 字是列表展示截断线),话题截到 tagsMax。没有发布文案时用切片
 * 标题兜底——发布框里至少有个能用的标题。
 */
export function adaptPost(
  clipTitle: string,
  copy: PublishCopy | undefined,
  spec: PlatformSpec,
  /** 开了 AIGC 标识:文案末尾附该平台的标注操作提示(v0.14,新规三次违规封号)。 */
  aigc = false
): AdaptedPost {
  const raw = (copy?.title ?? clipTitle).trim();
  const chars = Array.from(raw); // 按码点截,代理对/emoji 不切半
  const titleTruncated = chars.length > spec.titleMax;
  const title = titleTruncated ? chars.slice(0, spec.titleMax).join("") : raw;
  const hashtags = (copy?.hashtags ?? []).slice(0, spec.tagsMax);
  const parts = [title];
  if (hashtags.length > 0) parts.push(hashtags.join(" "));
  const body = [copy?.description ?? "", copy?.cta ?? ""].filter(Boolean).join("\n");
  if (body) parts.push(body);
  if (aigc) parts.push(`【AIGC 标注】${spec.aigcNoteZh}`);
  return { text: parts.join("\n\n") + "\n", title, titleTruncated, hashtags };
}

/** 视频硬链到发布包(同盘零拷贝);硬链不支持(网络盘/FAT)回退复制。 */
async function linkOrCopy(src: string, dest: string): Promise<void> {
  await rm(dest, { force: true }).catch(() => {});
  try {
    await link(src, dest);
  } catch {
    await copyFile(src, dest);
  }
}

/**
 * 按选中平台打包。任何单件失败(封面裁切/硬链/写文件)都跳过该件继续,
 * 单平台整体失败也只是少一个文件夹——绝不向上抛。
 */
export async function buildPublishPacks(
  outDir: string,
  clips: PackClipInput[],
  platformIds: string[],
  adaptCover: AdaptCoverFn,
  /** 开了 AIGC 标识:每平台文案附标注操作提示,manifest 一并记录。 */
  aigc = false
): Promise<PackSummary[]> {
  const summaries: PackSummary[] = [];
  for (const id of validPlatformIds(platformIds)) {
    const spec = platformSpec(id)!;
    try {
      const dir = join(outDir, PACK_DIR_NAME, safeDirName(spec.name.zh, spec.id));
      await mkdir(dir, { recursive: true });
      let truncated = 0;
      const rows: Array<Record<string, unknown>> = [];
      for (const clip of clips) {
        const base = basename(clip.file);
        await linkOrCopy(clip.file, join(dir, base)).catch(() => {});
        // 封面:按平台画幅裁切;源封面缺失或裁切失败都只是没封面
        let coverName: string | null = null;
        if (clip.coverFile) {
          const dest = join(dir, base.replace(/\.mp4$/, ".jpg"));
          const ok = await adaptCover(clip.coverFile, dest, spec).catch(() => false);
          if (ok) coverName = basename(dest);
        }
        const post = adaptPost(clip.title, clip.publish, spec, aigc);
        if (post.titleTruncated) truncated++;
        const postName = base.replace(/\.mp4$/, ".post.txt");
        await writeFile(join(dir, postName), post.text, "utf8").catch(() => {});
        rows.push({
          file: base,
          cover: coverName,
          postFile: postName,
          title: post.title,
          titleTruncated: post.titleTruncated,
          hashtags: post.hashtags,
        });
      }
      // manifest:适配了什么、按什么规格,发布前扫一眼就知道有没有坑
      await writeFile(
        join(dir, "manifest.json"),
        JSON.stringify(
          {
            platform: spec.id,
            name: spec.name.zh,
            coverSize: `${spec.cover.w}x${spec.cover.h}`,
            titleMax: spec.titleMax,
            tagsMax: spec.tagsMax,
            note: spec.noteZh,
            // AIGC 标注提醒:开了标识才写(发布前扫 manifest 就知道该在平台点哪个开关)
            aigcNote: aigc ? spec.aigcNoteZh : null,
            clips: rows,
          },
          null,
          2
        ),
        "utf8"
      ).catch(() => {});
      summaries.push({ platform: spec.id, name: spec.name.zh, dir, clipCount: clips.length, truncatedTitles: truncated });
    } catch {
      // 单平台失败不拖垮其余平台
    }
  }
  return summaries;
}
