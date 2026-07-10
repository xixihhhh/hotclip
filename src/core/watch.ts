/**
 * 录播监听(watch 文件夹):盯住一个目录,新视频文件"写完落稳"后自动交给
 * 全托管切片管线——直播录完即切,7×24 无人值守,对接录播姬/OBS 等
 * "边录边写盘"的生态。
 *
 * 两个关键判断都为录播场景设计:
 * - 稳定性:录制中的文件会持续增长,必须连续 N 轮轮询大小/mtime 不变才算写完;
 * - 已处理记录(seen)持久化:重启应用不重切旧文件。
 * 轮询而非 fs.watch:网络盘/原子改名/分段写盘下 fs.watch 不可靠,轮询更稳。
 * 本文件纯逻辑(fs/时钟注入),可完整单测;真实接线在 main。
 */

/** 录播/视频常见扩展名(含 ts/flv 这类直播容器)。 */
const VIDEO_EXTS = new Set(["mp4", "mkv", "mov", "flv", "ts", "webm", "m4v", "avi"]);

export function isVideoFile(name: string): boolean {
  if (name.startsWith(".")) return false; // 隐藏文件/下载中的点前缀临时文件
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return VIDEO_EXTS.has(ext);
}

export interface WatchedFile {
  path: string;
  size: number;
  mtimeMs: number;
}

/** 已处理记录(持久化 JSON 的形状):路径 → 处理时的尺寸指纹。 */
export interface SeenMap {
  [path: string]: { size: number; mtimeMs: number };
}

/** 同一路径同一指纹算已处理;文件被覆盖(尺寸/mtime 变了)则视为新文件。 */
export function isSeen(seen: SeenMap, f: WatchedFile): boolean {
  const rec = seen[f.path];
  return Boolean(rec && rec.size === f.size && rec.mtimeMs === f.mtimeMs);
}

export interface FolderWatcherOptions {
  /** 目录列举(只返回视频文件的 stat 信息);抛错视为该轮跳过。 */
  listDir: () => Promise<WatchedFile[]>;
  /** 写完落稳的新文件回调(串行:上一个处理完才会发下一个)。 */
  onStable: (file: WatchedFile) => Promise<void>;
  /** 已处理判断(通常查持久化 SeenMap)。 */
  isSeen: (file: WatchedFile) => boolean;
  /** 连续多少轮大小不变才算写完(默认 2 轮)。 */
  stableRounds?: number;
}

interface TrackState {
  size: number;
  mtimeMs: number;
  rounds: number;
}

/**
 * 目录监听核心:每次 tick() 列目录,跟踪每个文件的尺寸;连续 stableRounds
 * 轮不变且未处理过的文件按序进入 onStable。tick 由外部驱动(定时器/测试)。
 */
export class FolderWatcher {
  private tracks = new Map<string, TrackState>();
  private queue: WatchedFile[] = [];
  private processing = false;
  private readonly stableRounds: number;

  constructor(private readonly opts: FolderWatcherOptions) {
    this.stableRounds = Math.max(1, opts.stableRounds ?? 2);
  }

  /** 一轮轮询;返回本轮新入队的文件数(测试断言用)。 */
  async tick(): Promise<number> {
    let files: WatchedFile[];
    try {
      files = await this.opts.listDir();
    } catch {
      return 0; // 目录暂不可读(网络盘抖动):这轮跳过
    }
    const present = new Set<string>();
    let enqueued = 0;
    for (const f of files) {
      present.add(f.path);
      if (this.opts.isSeen(f)) {
        this.tracks.delete(f.path);
        continue;
      }
      const prev = this.tracks.get(f.path);
      if (prev && prev.size === f.size && prev.mtimeMs === f.mtimeMs) {
        prev.rounds += 1;
        if (prev.rounds >= this.stableRounds) {
          this.tracks.delete(f.path);
          this.queue.push(f);
          enqueued += 1;
        }
      } else {
        // 新文件或仍在增长:重新计稳定轮数
        this.tracks.set(f.path, { size: f.size, mtimeMs: f.mtimeMs, rounds: 0 });
      }
    }
    // 从目录里消失的文件(被移走/删除)不再跟踪
    for (const p of [...this.tracks.keys()]) if (!present.has(p)) this.tracks.delete(p);
    void this.drain();
    return enqueued;
  }

  /** 串行消费队列:录播机器同时只跑一条切片管线,不打爆 CPU。 */
  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const f = this.queue.shift()!;
        if (this.opts.isSeen(f)) continue; // 排队期间被别处标记
        try {
          await this.opts.onStable(f);
        } catch {
          // 单文件失败不影响后续(错误上报由 onStable 内部负责)
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /** 等待当前队列清空(测试/优雅停止用)。 */
  async idle(): Promise<void> {
    while (this.processing || this.queue.length > 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}
