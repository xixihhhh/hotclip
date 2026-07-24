import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { runDoctor, dirSize } from "../doctor";

let root: string;
afterEach(async () => {
  vi.unstubAllGlobals();
  if (root) await rm(root, { recursive: true, force: true });
});

async function freshRoot(): Promise<{ modelsRoot: string; cacheDir: string }> {
  root = await mkdtemp(join(tmpdir(), "hotclip-doctor-"));
  const modelsRoot = join(root, "models");
  const cacheDir = join(root, "cache");
  await mkdir(modelsRoot, { recursive: true });
  return { modelsRoot, cacheDir };
}

// 单测不赌 runner 的 ffmpeg/ffprobe 环境(Linux 上 ffprobe 曾跑不起来,Windows
// 上连 /bin/echo 都没有):路径解析和版本探测都注入假实现,不碰真进程。
const fakeBins = { ffmpeg: () => "/fake/ffmpeg", ffprobe: () => "/fake/ffprobe" };
const fakeProbe = async (): Promise<string> => "fake version 1.0\n";

describe("dirSize", () => {
  it("递归求和,不存在按 0", async () => {
    const { modelsRoot } = await freshRoot();
    await mkdir(join(modelsRoot, "a/b"), { recursive: true });
    await writeFile(join(modelsRoot, "a/x.bin"), Buffer.alloc(10));
    await writeFile(join(modelsRoot, "a/b/y.bin"), Buffer.alloc(5));
    expect(await dirSize(join(modelsRoot, "a"))).toBe(15);
    expect(await dirSize(join(modelsRoot, "不存在"))).toBe(0);
  });
});

describe("runDoctor", () => {
  it("空环境:核心模型报未安装并进 missingCoreModels,LLM 未配置是 warn 不是 fail", async () => {
    const { modelsRoot, cacheDir } = await freshRoot();
    const report = await runDoctor({ modelsRoot, cacheDir, llm: null, resolveBinaries: fakeBins, probeBinaryVersion: fakeProbe });

    // 默认管线四个核心模型都缺
    expect(report.missingCoreModels.map((a) => a.id)).toEqual([
      "sensevoice-2024-07-17",
      "yunet-2023mar",
      "emotion-ferplus-8",
      "transnetv2-onnx",
    ]);
    const sv = report.checks.find((c) => c.name.includes("SenseVoice"));
    expect(sv?.status).toBe("warn");
    expect(sv?.detail).toContain("未安装");
    expect(sv?.fix).toContain("--download");

    // 可选模型缺失不告警
    const fireRed = report.checks.find((c) => c.name.includes("FireRed"));
    expect(fireRed?.status).toBe("ok");

    const llm = report.checks.find((c) => c.name === "LLM 配置");
    expect(llm?.status).toBe("warn");
    expect(llm?.fix).toContain("HOTCLIP_LLM_BASE_URL");

    // 二进制可用(注入的假二进制)时报 ok
    expect(report.checks.find((c) => c.name === "ffmpeg")?.status).toBe("ok");
    expect(report.checks.find((c) => c.name === "ffprobe")?.status).toBe("ok");
  });

  it("二进制解析失败报 fail 并给修复建议", async () => {
    const { modelsRoot, cacheDir } = await freshRoot();
    const report = await runDoctor({
      modelsRoot,
      cacheDir,
      llm: null,
      resolveBinaries: {
        ffmpeg: () => "/bin/echo",
        ffprobe: () => {
          throw new Error("no binary for this platform");
        },
      },
    });
    const ffprobe = report.checks.find((c) => c.name === "ffprobe");
    expect(ffprobe?.status).toBe("fail");
    expect(ffprobe?.fix).toContain("pnpm install");
  });

  it("已装模型报体积;断点文件报续传量", async () => {
    const { modelsRoot, cacheDir } = await freshRoot();
    // YuNet 装好(singleFile 形态)
    await mkdir(join(modelsRoot, "yunet-2023mar"), { recursive: true });
    await writeFile(join(modelsRoot, "yunet-2023mar", "model.onnx"), Buffer.alloc(1024 * 1024));
    // SenseVoice 留一个断点文件
    await writeFile(join(modelsRoot, "sensevoice-2024-07-17.download.tar.bz2"), Buffer.alloc(2 * 1024 * 1024));

    const report = await runDoctor({ modelsRoot, cacheDir, llm: null, resolveBinaries: fakeBins, probeBinaryVersion: fakeProbe });
    const yunet = report.checks.find((c) => c.name.includes("YuNet"));
    expect(yunet?.status).toBe("ok");
    expect(yunet?.detail).toContain("已安装");
    const sv = report.checks.find((c) => c.name.includes("SenseVoice"));
    expect(sv?.detail).toContain("断点");
    expect(report.missingCoreModels.map((a) => a.id)).not.toContain("yunet-2023mar");
  });

  it("LLM 端点:收到 HTTP 响应算可达,网络错误算连不上", async () => {
    const { modelsRoot, cacheDir } = await freshRoot();
    const llm = { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" };

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    let report = await runDoctor({ modelsRoot, cacheDir, llm, resolveBinaries: fakeBins, probeBinaryVersion: fakeProbe });
    expect(report.checks.find((c) => c.name === "LLM 端点")?.status).toBe("ok");

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))));
    report = await runDoctor({ modelsRoot, cacheDir, llm, resolveBinaries: fakeBins, probeBinaryVersion: fakeProbe });
    const check = report.checks.find((c) => c.name === "LLM 端点");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("连不上");
  });
});
