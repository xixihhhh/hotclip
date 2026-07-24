import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { parseContentRange, candidateUrls, ensureModel, extractTarBz2, type ModelAsset } from "../models";

describe("parseContentRange", () => {
  it("解析标准 bytes 起-止/总长", () => {
    expect(parseContentRange("bytes 100-999/1000")).toEqual({ start: 100, total: 1000 });
  });

  it("非法/缺失返回 null", () => {
    expect(parseContentRange(null)).toBeNull();
    expect(parseContentRange("")).toBeNull();
    expect(parseContentRange("bytes */1000")).toBeNull();
  });
});

describe("candidateUrls", () => {
  it("镜像前缀在前、altUrls 居中、主 URL 兜底", () => {
    const asset: ModelAsset = {
      id: "x",
      url: "https://github.com/a/b.tar.bz2",
      mirrors: ["https://m1/", "https://m2/"],
      altUrls: ["https://alt/b.tar.bz2"],
      extractedDir: "x",
      approxBytes: 1,
    };
    expect(candidateUrls(asset)).toEqual([
      "https://m1/https://github.com/a/b.tar.bz2",
      "https://m2/https://github.com/a/b.tar.bz2",
      "https://alt/b.tar.bz2",
      "https://github.com/a/b.tar.bz2",
    ]);
  });
});

// ---- 断点续传:mock fetch,singleFile 资产走完整 ensureModel 流程 ----

const FULL = Buffer.from("0123456789abcdefghij"); // 20 字节的"模型文件"

function asset(overrides: Partial<ModelAsset> = {}): ModelAsset {
  return {
    id: "test-model",
    url: "https://origin/model.onnx",
    mirrors: [],
    extractedDir: "test-model",
    approxBytes: FULL.length,
    singleFile: "model.onnx",
    ...overrides,
  };
}

/**
 * 前 n 字节正常吐出后断流的响应体(模拟 GitHub 大文件中途 terminated)。
 * 必须 pull 式:同步 enqueue+error 会让规范把未读队列直接丢弃,字节送不到。
 */
function brokenBody(bytes: Buffer): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new Uint8Array(bytes));
      } else {
        controller.error(new Error("terminated"));
      }
    },
  });
}

function fullBody(bytes: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

let root: string;
afterEach(async () => {
  vi.unstubAllGlobals();
  if (root) await rm(root, { recursive: true, force: true });
});

async function freshRoot(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "hotclip-models-"));
  return root;
}

describe("ensureModel 断点续传", () => {
  it("断流后带 Range 续传,最终文件完整", async () => {
    const modelsRoot = await freshRoot();
    const cut = 8;
    const calls: Array<string | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const range = (init?.headers as Record<string, string> | undefined)?.Range;
        calls.push(range);
        if (!range) {
          // 首次全量:吐 8 字节后断流
          return new Response(brokenBody(FULL.subarray(0, cut)), {
            status: 200,
            headers: { "content-length": String(FULL.length) },
          });
        }
        // 续传:校验起点并补齐剩余字节
        expect(range).toBe(`bytes=${cut}-`);
        return new Response(fullBody(FULL.subarray(cut)), {
          status: 206,
          headers: {
            "content-range": `bytes ${cut}-${FULL.length - 1}/${FULL.length}`,
            "content-length": String(FULL.length - cut),
          },
        });
      })
    );

    const a = asset();
    await ensureModel(modelsRoot, a, undefined);
    const installed = await readFile(join(modelsRoot, a.extractedDir, "model.onnx"));
    expect(installed.equals(FULL)).toBe(true);
    expect(calls).toEqual([undefined, `bytes=${cut}-`]);
  });

  it("服务端不支持 Range(续传返回 200)则覆盖重下,不叠加污染", async () => {
    const modelsRoot = await freshRoot();
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n++;
        if (n === 1) {
          return new Response(brokenBody(FULL.subarray(0, 5)), {
            status: 200,
            headers: { "content-length": String(FULL.length) },
          });
        }
        // 无视 Range 直接全量 200
        return new Response(fullBody(FULL), {
          status: 200,
          headers: { "content-length": String(FULL.length) },
        });
      })
    );

    const a = asset();
    await ensureModel(modelsRoot, a, undefined);
    const installed = await readFile(join(modelsRoot, a.extractedDir, "model.onnx"));
    expect(installed.equals(FULL)).toBe(true);
  });

  it("镜像谎报续传起点则丢弃部分文件重来", async () => {
    const modelsRoot = await freshRoot();
    let sawLie = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const range = (init?.headers as Record<string, string> | undefined)?.Range;
        if (!range) {
          if (sawLie) return new Response(fullBody(FULL), { status: 200, headers: { "content-length": String(FULL.length) } });
          return new Response(brokenBody(FULL.subarray(0, 5)), {
            status: 200,
            headers: { "content-length": String(FULL.length) },
          });
        }
        // 206 但 content-range 起点对不上:部分文件必须被丢弃
        sawLie = true;
        return new Response(fullBody(FULL.subarray(2)), {
          status: 206,
          headers: { "content-range": `bytes 2-${FULL.length - 1}/${FULL.length}` },
        });
      })
    );

    const a = asset();
    await ensureModel(modelsRoot, a, undefined);
    const installed = await readFile(join(modelsRoot, a.extractedDir, "model.onnx"));
    expect(installed.equals(FULL)).toBe(true);
  });

  it("已有完整字节时 416 视为下载完成", async () => {
    const modelsRoot = await freshRoot();
    const a = asset();
    // 预置完整的部分文件(上次断在最后一刻)
    await writeFile(join(modelsRoot, `${a.id}.download.tar.bz2`), FULL);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 416 }))
    );

    await ensureModel(modelsRoot, a, undefined);
    const installed = await stat(join(modelsRoot, a.extractedDir, "model.onnx"));
    expect(installed.size).toBe(FULL.length);
  });

  it("彻底失败时保留部分文件供下次续传", async () => {
    const modelsRoot = await freshRoot();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(brokenBody(FULL.subarray(0, 4)), {
          status: 200,
          headers: { "content-length": String(FULL.length) },
        })
      )
    );

    const a = asset();
    await expect(ensureModel(modelsRoot, a, undefined)).rejects.toThrow(/model download failed/);
    const partial = await stat(join(modelsRoot, `${a.id}.download.tar.bz2`));
    expect(partial.size).toBeGreaterThan(0);
  });
});

// ---- tar.bz2 解压:issue #17 Windows 内置 tar 不支持 bzip2,纯 JS 兜底 ----

const FIXTURE = join(__dirname, "fixtures", "fixture-model.tar.bz2");

function archiveAsset(overrides: Partial<ModelAsset> = {}): ModelAsset {
  return {
    id: "fixture-model",
    url: "https://origin/fixture-model.tar.bz2",
    mirrors: [],
    extractedDir: "fixture-model",
    approxBytes: 650,
    ...overrides,
  };
}

describe("extractTarBz2 纯 JS 兜底", () => {
  it("跳过系统 tar(systemTar=null)也能解出归档", async () => {
    const dest = await freshRoot();
    const seen: Array<"download" | "extract" | undefined> = [];
    await extractTarBz2(FIXTURE, dest, (p) => seen.push(p.phase), null);
    const tokens = await readFile(join(dest, "fixture-model", "tokens.txt"), "utf8");
    expect(tokens).toBe("hello tokens\n");
    // 全程都是 extract 阶段,且报了真实字节进度
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s === "extract")).toBe(true);
  });

  it("系统 tar 不可用(Windows 无 bzip2 场景)自动落到 JS 解压", async () => {
    const dest = await freshRoot();
    await extractTarBz2(FIXTURE, dest, undefined, "hotclip-no-such-tar-binary");
    const onnx = await readFile(join(dest, "fixture-model", "model.int8.onnx"), "utf8");
    expect(onnx).toBe("fake onnx bytes");
  });
});

describe("ensureModel 归档资产端到端", () => {
  it("下载 tar.bz2 → 解压 → 原子落位,归档清理", async () => {
    const modelsRoot = await freshRoot();
    const bytes = await readFile(FIXTURE);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(fullBody(bytes), {
          status: 200,
          headers: { "content-length": String(bytes.length) },
        })
      )
    );

    const a = archiveAsset();
    const dir = await ensureModel(modelsRoot, a, undefined);
    const tokens = await readFile(join(dir, "tokens.txt"), "utf8");
    expect(tokens).toBe("hello tokens\n");
    // 归档与 staging 目录都不残留
    await expect(stat(join(modelsRoot, `${a.id}.download.tar.bz2`))).rejects.toThrow();
    await expect(stat(join(modelsRoot, `${a.id}.extracting`))).rejects.toThrow();
  });

  it("真损坏的归档:两路解压都失败→删档换镜像,不留下能被误判已安装的目录", async () => {
    const modelsRoot = await freshRoot();
    const garbage = Buffer.from("this is definitely not a bzip2 archive at all");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(fullBody(garbage), {
          status: 200,
          headers: { "content-length": String(garbage.length) },
        })
      )
    );

    const a = archiveAsset();
    await expect(ensureModel(modelsRoot, a, undefined)).rejects.toThrow();
    // 损坏归档已删除(下次从零重下),extractedDir 没有被残缺解压污染
    await expect(stat(join(modelsRoot, `${a.id}.download.tar.bz2`))).rejects.toThrow();
    await expect(stat(join(modelsRoot, a.extractedDir))).rejects.toThrow();
  });
});
