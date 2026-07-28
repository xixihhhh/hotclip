/**
 * 跨盘搬家(issue #3 的主场景——用户就是想把 1GB 模型挪到别的盘)。
 * 跨盘时 rename 会 EXDEV 失败,退回「复制 → 校验 → 删原件」。这条路径最容易
 * 把模型搬丢,所以单独 mock 出 EXDEV 来跑:复制成功要真删原件,复制失败必须
 * 原件分毫不动、并且不留半成品目标目录。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

const renameMock = vi.fn();
const cpMock = vi.fn();

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    // 默认转发真实实现,测试内按需改写成失败
    rename: (...args: Parameters<typeof actual.rename>) => renameMock(...args),
    cp: (...args: Parameters<typeof actual.cp>) => cpMock(...args),
  };
});

const { mkdtemp, mkdir, writeFile, readFile, readdir, rm, cp: realCp } = await vi.importActual<
  typeof import("fs/promises")
>("fs/promises");
const { join } = await import("path");
const { tmpdir } = await import("os");
const { dirSize, moveModelsDir } = await import("../models-inventory");

let base: string;
const EXDEV = Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "hotclip-xdisk-"));
  renameMock.mockReset();
  cpMock.mockReset();
  // 跨盘:rename 一律失败,cp 走真实复制
  renameMock.mockRejectedValue(EXDEV);
  cpMock.mockImplementation((...args: Parameters<typeof realCp>) => realCp(...args));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function seed(root: string): Promise<void> {
  await mkdir(join(root, "sense-voice"), { recursive: true });
  await writeFile(join(root, "sense-voice", "model.onnx"), "x".repeat(4096));
  await mkdir(join(root, "yunet"), { recursive: true });
  await writeFile(join(root, "yunet", "face.onnx"), "y".repeat(1024));
}

describe("moveModelsDir 跨盘", () => {
  it("rename 失败后走复制:文件完整到位,原目录才被删", async () => {
    const from = join(base, "old");
    const to = join(base, "new");
    await seed(from);

    const landed = await moveModelsDir(from, to);

    expect(renameMock).toHaveBeenCalled(); // 先试过 rename
    expect(cpMock).toHaveBeenCalled(); // 再退回复制
    expect(landed).toBe(to);
    expect(await readFile(join(to, "sense-voice", "model.onnx"), "utf8")).toBe("x".repeat(4096));
    expect(await dirSize(to)).toBe(5120);
    await expect(readdir(from)).rejects.toThrow();
  });

  it("复制中途失败:原目录分毫不动,半成品目标被清掉", async () => {
    const from = join(base, "old");
    const to = join(base, "new");
    await seed(from);
    // 第一个子目录复制成功,第二个炸掉——模拟中途断电/磁盘满
    let call = 0;
    cpMock.mockImplementation((...args: Parameters<typeof realCp>) => {
      call += 1;
      if (call > 1) return Promise.reject(new Error("ENOSPC: no space left on device"));
      return realCp(...args);
    });

    await expect(moveModelsDir(from, to)).rejects.toThrow(/原目录未改动/);

    expect(await dirSize(from)).toBe(5120); // 原件一个字节没少
    expect(await readFile(join(from, "yunet", "face.onnx"), "utf8")).toBe("y".repeat(1024));
    await expect(readdir(to)).rejects.toThrow(); // 半成品目标已清除
  });

  it("复制结果字节数少于原件 → 判定没搬成,原件保留", async () => {
    const from = join(base, "old");
    const to = join(base, "new");
    await seed(from);
    // 复制"成功"但实际只落了一部分内容(静默截断类故障)
    cpMock.mockImplementation(async (src: string, dest: string) => {
      await mkdir(dest, { recursive: true });
      await writeFile(join(dest, "truncated.bin"), "z");
    });

    await expect(moveModelsDir(from, to)).rejects.toThrow(/原目录未改动/);
    expect(await dirSize(from)).toBe(5120);
  });
});
