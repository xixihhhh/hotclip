import { describe, it, expect } from "vitest";
import { FolderWatcher, isVideoFile, isSeen, type WatchedFile, type SeenMap } from "../watch";

const f = (path: string, size: number, mtimeMs = 1000): WatchedFile => ({ path, size, mtimeMs });

describe("isVideoFile", () => {
  it("识别录播常见容器,拒绝隐藏文件与非视频", () => {
    for (const ok of ["a.mp4", "b.FLV", "c.ts", "d.mkv", "e.webm"]) expect(isVideoFile(ok)).toBe(true);
    for (const no of [".part.mp4", "a.txt", "b.jpg", "clips.json", "noext"]) expect(isVideoFile(no)).toBe(false);
  });
});

describe("isSeen", () => {
  it("同路径同指纹算已处理;文件被覆盖(指纹变)算新文件", () => {
    const seen: SeenMap = { "/r/a.mp4": { size: 100, mtimeMs: 1000 } };
    expect(isSeen(seen, f("/r/a.mp4", 100, 1000))).toBe(true);
    expect(isSeen(seen, f("/r/a.mp4", 200, 2000))).toBe(false);
    expect(isSeen(seen, f("/r/b.mp4", 100, 1000))).toBe(false);
  });
});

describe("FolderWatcher", () => {
  function makeWatcher(overrides: {
    files: () => WatchedFile[];
    seen?: SeenMap;
    onStable?: (file: WatchedFile) => Promise<void>;
  }): { watcher: FolderWatcher; processed: string[] } {
    const processed: string[] = [];
    const seen = overrides.seen ?? {};
    const watcher = new FolderWatcher({
      listDir: async () => overrides.files(),
      isSeen: (file) => isSeen(seen, file),
      onStable:
        overrides.onStable ??
        (async (file) => {
          processed.push(file.path);
          seen[file.path] = { size: file.size, mtimeMs: file.mtimeMs };
        }),
    });
    return { watcher, processed };
  }

  it("增长中的文件不触发;连续两轮稳定才处理,且只处理一次", async () => {
    let size = 100;
    const { watcher, processed } = makeWatcher({ files: () => [f("/r/rec.flv", size)] });
    await watcher.tick(); // 首见
    size = 200; // 还在写盘
    await watcher.tick();
    expect(processed).toEqual([]);
    await watcher.tick(); // 稳定第 1 轮
    expect(processed).toEqual([]);
    await watcher.tick(); // 稳定第 2 轮 → 触发
    await watcher.idle();
    expect(processed).toEqual(["/r/rec.flv"]);
    await watcher.tick(); // 已 seen,不再触发
    await watcher.tick();
    await watcher.idle();
    expect(processed).toEqual(["/r/rec.flv"]);
  });

  it("已在 seen 里的旧录播永不触发(重启不重切)", async () => {
    const { watcher, processed } = makeWatcher({
      files: () => [f("/r/old.mp4", 500, 42)],
      seen: { "/r/old.mp4": { size: 500, mtimeMs: 42 } },
    });
    for (let i = 0; i < 4; i++) await watcher.tick();
    await watcher.idle();
    expect(processed).toEqual([]);
  });

  it("多文件按序串行处理,单文件失败不影响后续", async () => {
    const order: string[] = [];
    let concurrent = 0;
    const seen: SeenMap = {};
    const { watcher } = makeWatcher({
      files: () => [f("/r/a.mp4", 1), f("/r/b.mp4", 2), f("/r/c.mp4", 3)],
      seen,
      onStable: async (file) => {
        concurrent += 1;
        expect(concurrent).toBe(1); // 串行保证
        await new Promise((r) => setTimeout(r, 5));
        seen[file.path] = { size: file.size, mtimeMs: file.mtimeMs };
        concurrent -= 1;
        if (file.path === "/r/b.mp4") throw new Error("这条坏了");
        order.push(file.path);
      },
    });
    await watcher.tick();
    await watcher.tick();
    await watcher.tick(); // 稳定 → 三个都入队
    await watcher.idle();
    expect(order).toEqual(["/r/a.mp4", "/r/c.mp4"]); // b 失败被跳过
  });

  it("目录暂不可读(网络盘抖动)该轮静默跳过", async () => {
    let fail = true;
    const files = [f("/r/x.mp4", 9)];
    const seen: SeenMap = {};
    const processed: string[] = [];
    const watcher = new FolderWatcher({
      listDir: async () => {
        if (fail) throw new Error("EIO");
        return files;
      },
      isSeen: (file) => isSeen(seen, file),
      onStable: async (file) => {
        processed.push(file.path);
        seen[file.path] = { size: file.size, mtimeMs: file.mtimeMs };
      },
    });
    expect(await watcher.tick()).toBe(0);
    fail = false;
    await watcher.tick();
    await watcher.tick();
    await watcher.tick();
    await watcher.idle();
    expect(processed).toEqual(["/r/x.mp4"]);
  });

  it("消失的文件(被移走)停止跟踪,不误触发", async () => {
    let present = true;
    const { watcher, processed } = makeWatcher({ files: () => (present ? [f("/r/gone.mp4", 7)] : []) });
    await watcher.tick();
    present = false;
    await watcher.tick();
    await watcher.tick();
    await watcher.tick();
    await watcher.idle();
    expect(processed).toEqual([]);
  });
});
