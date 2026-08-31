import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
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

    // 默认管线五个核心模型都缺
    expect(report.missingCoreModels.map((a) => a.id)).toEqual([
      "sensevoice-2024-07-17",
      "yunet-2023mar",
      "emotion-ferplus-8",
      "transnetv2-onnx",
      "silero-vad-v6",
    ]);
    const sv = report.checks.find((c) => c.name.includes("SenseVoice"));
    expect(sv?.status).toBe("warn");
    expect(sv?.detail).toContain("未安装");
    expect(sv?.fix).toContain("预下载");

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
    expect(ffprobe?.fix).toContain("重新安装应用");
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

  it("下载器缺失不告警,已缓存时校验完整性", async () => {
    const { modelsRoot, cacheDir } = await freshRoot();
    const toolsDir = join(root, "tools");
    let report = await runDoctor({ modelsRoot, cacheDir, toolsDir, llm: null, resolveBinaries: fakeBins, probeBinaryVersion: fakeProbe });
    expect(report.checks.find((c) => c.id === "downloader")).toMatchObject({ status: "ok" });

    await mkdir(toolsDir, { recursive: true });
    const binary = join(toolsDir, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
    const bytes = Buffer.from("verified-tool");
    await writeFile(binary, bytes);
    await writeFile(`${binary}.sha256`, `${createHash("sha256").update(bytes).digest("hex")}\n`);
    report = await runDoctor({ modelsRoot, cacheDir, toolsDir, llm: null, resolveBinaries: fakeBins, probeBinaryVersion: fakeProbe });
    expect(report.checks.find((c) => c.id === "downloader")).toMatchObject({ status: "ok", detail: expect.stringContaining("校验通过") });

    await writeFile(`${binary}.sha256`, "bad");
    report = await runDoctor({ modelsRoot, cacheDir, toolsDir, llm: null, resolveBinaries: fakeBins, probeBinaryVersion: fakeProbe });
    expect(report.checks.find((c) => c.id === "downloader")).toMatchObject({ status: "warn", fix: expect.stringContaining("自动删除") });
  });

  it("英文桌面报告不混入中文操作文案", async () => {
    const { modelsRoot, cacheDir } = await freshRoot();
    const report = await runDoctor({ modelsRoot, cacheDir, llm: null, zh: false, resolveBinaries: fakeBins, probeBinaryVersion: fakeProbe });
    expect(report.checks.find((c) => c.id.startsWith("model:"))).toMatchObject({ name: expect.stringContaining("transcription"), detail: expect.stringContaining("Not installed") });
    expect(report.checks.find((c) => c.id === "llm")).toMatchObject({ name: "LLM configuration", fix: expect.stringContaining("AI model settings") });
    expect(report.checks.find((c) => c.id === "cache")?.detail).toContain("Empty");
  });

  it("可选渲染缓存检查显示占用并支持英文报告", async () => {
    const { modelsRoot, cacheDir } = await freshRoot();
    const renderCacheDir = join(root, "render-cache");
    await mkdir(renderCacheDir, { recursive: true });
    await writeFile(join(renderCacheDir, "base.mp4"), Buffer.alloc(1024 * 1024));

    let report = await runDoctor({ modelsRoot, cacheDir, renderCacheDir, llm: null, resolveBinaries: fakeBins, probeBinaryVersion: fakeProbe });
    expect(report.checks.find((c) => c.id === "render-cache")).toMatchObject({ name: "基础渲染缓存", status: "ok", detail: expect.stringContaining("1MB") });

    report = await runDoctor({ modelsRoot, cacheDir, renderCacheDir, llm: null, zh: false, resolveBinaries: fakeBins, probeBinaryVersion: fakeProbe });
    expect(report.checks.find((c) => c.id === "render-cache")).toMatchObject({ name: "Render cache", detail: expect.stringContaining("limited to 1GB") });
  });

  it("多模态证据索引独立显示占用和 64MB 上限", async () => {
    const { modelsRoot, cacheDir } = await freshRoot();
    const evidenceCacheDir = join(root, "evidence-index");
    await mkdir(evidenceCacheDir, { recursive: true });
    await writeFile(join(evidenceCacheDir, "signals.json"), Buffer.alloc(2 * 1024 * 1024));

    let report = await runDoctor({ modelsRoot, cacheDir, evidenceCacheDir, llm: null, resolveBinaries: fakeBins, probeBinaryVersion: fakeProbe });
    expect(report.checks.find((check) => check.id === "evidence-index")).toMatchObject({
      name: "多模态证据索引",
      status: "ok",
      detail: expect.stringContaining("2MB"),
    });
    report = await runDoctor({ modelsRoot, cacheDir, evidenceCacheDir, llm: null, zh: false, resolveBinaries: fakeBins, probeBinaryVersion: fakeProbe });
    expect(report.checks.find((check) => check.id === "evidence-index")).toMatchObject({
      name: "Multimodal evidence index",
      detail: expect.stringContaining("limited to 64MB"),
    });
  });

  it("LLM 端点:区分成功、路由错误、凭据错误和网络错误", async () => {
    const { modelsRoot, cacheDir } = await freshRoot();
    const llm = { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" };

    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    let report = await runDoctor({ modelsRoot, cacheDir, llm, resolveBinaries: fakeBins, probeBinaryVersion: fakeProbe });
    expect(report.checks.find((c) => c.name === "LLM 端点")?.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/models"), expect.objectContaining({ headers: { Authorization: "Bearer k" } }));

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    report = await runDoctor({ modelsRoot, cacheDir, llm, resolveBinaries: fakeBins, probeBinaryVersion: fakeProbe });
    expect(report.checks.find((c) => c.name === "LLM 端点")).toMatchObject({ status: "warn", id: "llm" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    report = await runDoctor({ modelsRoot, cacheDir, llm, resolveBinaries: fakeBins, probeBinaryVersion: fakeProbe });
    expect(report.checks.find((c) => c.name === "LLM 端点")).toMatchObject({ status: "fail", id: "llm" });

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))));
    report = await runDoctor({ modelsRoot, cacheDir, llm, resolveBinaries: fakeBins, probeBinaryVersion: fakeProbe });
    const check = report.checks.find((c) => c.name === "LLM 端点");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("连不上");
  });
});
