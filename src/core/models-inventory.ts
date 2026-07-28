/**
 * 模型清点与搬家(issue #3)。
 *
 * 用户找不到那 1GB 模型存在哪儿——目录以前从没在界面上露过面。这里负责
 * 「一共几个、各占多大、装没装」和「整个目录挪到别的盘」两件事。
 * 搬家的安全底线:**旧目录在新目录完整落地之前一个字节都不能删**——
 * 模型重下一次要一个多小时,搬家搬丢了比不能搬严重得多。
 */
import { cp, mkdir, readdir, rename, rm, stat } from "fs/promises";
import { join, relative, resolve, sep } from "path";
import {
  isModelInstalled,
  modelDir,
  SENSEVOICE_MODEL,
  PARAFORMER_MODEL,
  FIRERED_MODEL,
  YUNET_MODEL,
  EMOTION_MODEL,
  PUNCT_MODEL,
  SEGMENTATION_MODEL,
  SPEAKER_EMBEDDING_MODEL,
  TRANSNETV2_MODEL,
  type ModelAsset,
} from "./models";

/** 全部可下载模型,按用户能理解的用途分组标签(界面直接展示这个顺序)。 */
export const MODEL_CATALOG: Array<{ asset: ModelAsset; useKey: string }> = [
  { asset: SENSEVOICE_MODEL, useKey: "useAsrFast" },
  { asset: PARAFORMER_MODEL, useKey: "useAsrAccurate" },
  { asset: FIRERED_MODEL, useKey: "useAsrDialect" },
  { asset: PUNCT_MODEL, useKey: "usePunct" },
  { asset: SEGMENTATION_MODEL, useKey: "useDiarize" },
  { asset: SPEAKER_EMBEDDING_MODEL, useKey: "useDiarize" },
  { asset: YUNET_MODEL, useKey: "useFace" },
  { asset: EMOTION_MODEL, useKey: "useEmotion" },
  { asset: TRANSNETV2_MODEL, useKey: "useShots" },
];

export interface ModelEntry {
  id: string;
  /** 用途文案的 i18n key(界面自己翻译)。 */
  useKey: string;
  installed: boolean;
  /** 已装模型的实际磁盘占用;未装为 0。 */
  bytes: number;
  /** 未装时给出的预计下载体积。 */
  approxBytes: number;
}

export interface ModelsInfo {
  root: string;
  defaultRoot: string;
  /** 已装模型合计占用。 */
  totalBytes: number;
  entries: ModelEntry[];
}

/** 递归统计目录占用;读不到的条目算 0(权限/竞态不该让整页报错)。 */
export async function dirSize(path: string): Promise<number> {
  let total = 0;
  let items: string[];
  try {
    const s = await stat(path);
    if (s.isFile()) return s.size;
    items = await readdir(path);
  } catch {
    return 0;
  }
  for (const name of items) {
    total += await dirSize(join(path, name));
  }
  return total;
}

/** 清点模型:装了哪些、各占多大、总共多大。 */
export async function inspectModels(root: string, defaultRoot: string): Promise<ModelsInfo> {
  const entries: ModelEntry[] = [];
  for (const { asset, useKey } of MODEL_CATALOG) {
    const installed = await isModelInstalled(root, asset);
    entries.push({
      id: asset.id,
      useKey,
      installed,
      bytes: installed ? await dirSize(modelDir(root, asset)) : 0,
      approxBytes: asset.approxBytes,
    });
  }
  return {
    root,
    defaultRoot,
    totalBytes: entries.reduce((a, e) => a + e.bytes, 0),
    entries,
  };
}

/** 目标目录是否落在源目录内部(搬进自己的子目录会无限递归)。 */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith("/"));
}

/**
 * 把模型目录整体搬到新位置,返回最终生效的路径。
 *
 * 同盘走 rename(瞬间);跨盘退回「先完整复制、校验通过再删原件」。
 * 复制中途失败会清掉半成品目标目录,原件保持不动——宁可白搬一次,不能搬丢。
 */
export async function moveModelsDir(from: string, to: string): Promise<string> {
  const src = resolve(from);
  const dest = resolve(to);
  if (src === dest) return dest;
  if (isInside(src, dest)) throw new Error("目标目录在当前模型目录内部,请换一个位置");

  const srcExists = await stat(src).then((s) => s.isDirectory()).catch(() => false);
  await mkdir(dest, { recursive: true });
  if (!srcExists) return dest; // 还没下过任何模型:换个位置即可,没什么可搬

  const names = await readdir(src);
  if (names.length === 0) return dest;

  // 目标非空时不冒险合并——让用户自己挑个干净目录,免得同名模型互相覆盖
  if ((await readdir(dest)).length > 0) throw new Error("目标目录不是空的,请选一个空文件夹");

  try {
    await rename(src, dest);
    return dest;
  } catch {
    /* 跨盘 rename 会失败(EXDEV),退回复制 */
  }

  try {
    for (const name of names) {
      await cp(join(src, name), join(dest, name), { recursive: true, force: true });
    }
    // 复制完整性粗校验:总字节对不上就当没搬成
    const [srcBytes, destBytes] = [await dirSize(src), await dirSize(dest)];
    if (destBytes < srcBytes) throw new Error("复制不完整");
    await rm(src, { recursive: true, force: true });
    return dest;
  } catch (e) {
    await rm(dest, { recursive: true, force: true }).catch(() => {});
    throw new Error(`模型搬家失败,原目录未改动:${e instanceof Error ? e.message : String(e)}`);
  }
}
