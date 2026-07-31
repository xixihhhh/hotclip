/**
 * 模型搬家(issue #3):用户拿这个功能挪 1GB 的模型,搬丢了要重下一小时。
 * 所以这里钉死的不是「搬得成」,而是「搬不成时原件必须还在」。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import * as nodePath from "path";
import { join } from "path";
import { dirSize, isInside, moveModelsDir } from "../models-inventory";
import { defaultModelsRoot, readAppSettings, resolveModelsRoot, writeAppSettings } from "../app-settings";

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "hotclip-models-"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function seedModels(root: string): Promise<void> {
  await mkdir(join(root, "sherpa-onnx-sense-voice"), { recursive: true });
  await writeFile(join(root, "sherpa-onnx-sense-voice", "model.onnx"), "x".repeat(2048));
  await mkdir(join(root, "yunet-face"), { recursive: true });
  await writeFile(join(root, "yunet-face", "face.onnx"), "y".repeat(1024));
}

describe("dirSize", () => {
  it("递归累加子目录里的文件字节", async () => {
    await seedModels(base);
    expect(await dirSize(base)).toBe(3072);
  });

  it("目录不存在算 0,不抛异常(设置页不该因为路径没了整页报错)", async () => {
    expect(await dirSize(join(base, "nope"))).toBe(0);
  });
});

describe("isInside", () => {
  it("识别子目录与自身", () => {
    expect(isInside("/a/b", "/a/b/c")).toBe(true);
    expect(isInside("/a/b", "/a/b")).toBe(true);
  });

  it("同级和上级不算内部", () => {
    expect(isInside("/a/b", "/a/c")).toBe(false);
    expect(isInside("/a/b", "/a")).toBe(false);
  });

  // Windows 语义借 path.win32 在任意平台复现——issue #4:用户(中文用户名)想把
  // 模型从 C 盘搬去 E 盘,relative() 跨盘返回绝对路径,曾被误判成「目标在内部」
  describe("Windows 路径", () => {
    const w = nodePath.win32;

    it("跨盘目标不算内部(issue #4:C 盘搬 E 盘曾被误拦)", () => {
      expect(isInside("C:\\Users\\楚心\\AppData\\Roaming\\hotclip\\models", "E:\\AI-tool\\hotclip\\models", w)).toBe(false);
      expect(isInside("C:\\models", "D:\\models", w)).toBe(false);
    });

    it("同盘子目录与自身仍然算内部", () => {
      expect(isInside("C:\\models", "C:\\models\\sub", w)).toBe(true);
      expect(isInside("C:\\models", "c:\\models", w)).toBe(true);
    });

    it("同盘同级/上级/同名前缀不算内部", () => {
      expect(isInside("C:\\models", "C:\\models2", w)).toBe(false);
      expect(isInside("C:\\a\\models", "C:\\a", w)).toBe(false);
    });
  });
});

describe("moveModelsDir", () => {
  it("同盘搬家:文件原样到新目录,旧目录清空", async () => {
    const from = join(base, "old");
    const to = join(base, "new");
    await seedModels(from);

    const landed = await moveModelsDir(from, to);

    expect(landed).toBe(to);
    expect(await readFile(join(to, "sherpa-onnx-sense-voice", "model.onnx"), "utf8")).toBe("x".repeat(2048));
    expect(await dirSize(to)).toBe(3072);
    await expect(readdir(from)).rejects.toThrow(); // 旧目录已不复存在
  });

  it("目标就是当前目录时直接返回,不做任何事", async () => {
    const dir = join(base, "same");
    await seedModels(dir);
    expect(await moveModelsDir(dir, dir)).toBe(dir);
    expect(await dirSize(dir)).toBe(3072);
  });

  it("拒绝搬进自己的子目录(否则递归复制自己)", async () => {
    const from = join(base, "models");
    await seedModels(from);
    await expect(moveModelsDir(from, join(from, "inner"))).rejects.toThrow(/内部/);
    expect(await dirSize(from)).toBe(3072); // 原件没被动过
  });

  it("目标目录非空时拒绝,避免同名模型互相覆盖", async () => {
    const from = join(base, "old");
    const to = join(base, "busy");
    await seedModels(from);
    await mkdir(to, { recursive: true });
    await writeFile(join(to, "someone-elses-file"), "keep me");

    await expect(moveModelsDir(from, to)).rejects.toThrow(/空/);
    expect(await dirSize(from)).toBe(3072); // 原件仍在
    expect(await readFile(join(to, "someone-elses-file"), "utf8")).toBe("keep me"); // 别人的文件没被删
  });

  it("还没下过模型时:换个位置即可,不报错", async () => {
    const to = join(base, "fresh");
    expect(await moveModelsDir(join(base, "never-downloaded"), to)).toBe(to);
  });
});

describe("app-settings", () => {
  it("没有配置文件时回落出厂模型目录", () => {
    expect(resolveModelsRoot(base)).toBe(defaultModelsRoot(base));
    expect(readAppSettings(base)).toEqual({});
  });

  it("写过自定义目录后按自定义的算", () => {
    writeAppSettings(base, { modelsDir: "/data/hotclip-models" });
    expect(resolveModelsRoot(base)).toBe("/data/hotclip-models");
  });

  it("清空自定义目录 → 回到出厂位置", () => {
    writeAppSettings(base, { modelsDir: "/data/x" });
    writeAppSettings(base, { modelsDir: undefined });
    expect(resolveModelsRoot(base)).toBe(defaultModelsRoot(base));
  });

  it("配置文件损坏 → 回落默认而不是崩掉(设置坏了不能挡住出片)", async () => {
    await writeFile(join(base, "settings.json"), "{ not json");
    expect(resolveModelsRoot(base)).toBe(defaultModelsRoot(base));
  });

  it("空白路径视为没设置", async () => {
    await writeFile(join(base, "settings.json"), JSON.stringify({ modelsDir: "   " }));
    expect(resolveModelsRoot(base)).toBe(defaultModelsRoot(base));
  });
});
