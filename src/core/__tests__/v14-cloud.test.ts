/**
 * v0.14 云端档:Atlas 生成媒体客户端 / AI 封面双档 / AI BGM。
 * fetch 全部打桩——测协议形状与容错,不打真网络。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { atlasMediaBase, generateMedia } from "../atlas-media";
import { coverPrompt, coverRequestBody, COVER_MODELS, COVER_COST_USD } from "../cover-ai";
import { bgmPrompt, BGM_MODEL } from "../bgm-ai";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("atlasMediaBase(端点推导)", () => {
  it("Atlas 域 → …/api/v1/model;其他端点/坏输入 → null", () => {
    expect(atlasMediaBase("https://api.atlascloud.ai/v1")).toBe("https://api.atlascloud.ai/api/v1/model");
    expect(atlasMediaBase("http://localhost:11434/v1")).toBeNull();
    expect(atlasMediaBase("https://api.openai.com/v1")).toBeNull();
    expect(atlasMediaBase("not a url")).toBeNull();
    expect(atlasMediaBase(undefined)).toBeNull();
  });
});

describe("coverPrompt / coverRequestBody(封面双档)", () => {
  it("标题原样进引号,超长截到 16 字;中英文各一版", () => {
    const zh = coverPrompt("十几块和两块多的纸巾差在哪这是超长标题啊", "实测吸水速度", true);
    expect(zh).toContain("「十几块和两块多的纸巾差在哪这是超」");
    expect(zh).toContain("实测吸水速度");
    const en = coverPrompt("Why cheap tissues fail", undefined, false);
    expect(en).toContain('"Why cheap tissues fail"');
  });
  it("走量档 Seedream 用 size 竖版;精品档 Nano Banana 用 aspect_ratio 3:4 jpeg", () => {
    const vol = coverRequestBody("volume", "p");
    expect(vol.model).toBe(COVER_MODELS.volume);
    expect(vol.size).toBe("1728*2304");
    const pre = coverRequestBody("premium", "p");
    expect(pre.model).toBe(COVER_MODELS.premium);
    expect(pre.aspect_ratio).toBe("3:4");
    expect(pre.output_format).toBe("jpeg");
    // 价格常量:走量必须比精品便宜(档位语义)
    expect(COVER_COST_USD.volume).toBeLessThan(COVER_COST_USD.premium);
  });
});

describe("bgmPrompt(品类风格)", () => {
  it("永远带纯音乐/循环友好约束;品类映射生效,未知回退通用档", () => {
    for (const g of ["shopping", "knowledge", undefined, "no-such-genre"]) {
      const p = bgmPrompt(g);
      expect(p).toContain("instrumental only");
      expect(p).toContain("no vocals");
      expect(p).toContain("loop-friendly");
    }
    expect(bgmPrompt("knowledge")).toContain("lofi");
    expect(bgmPrompt("shopping")).not.toBe(bgmPrompt("game"));
    expect(BGM_MODEL).toBe("minimax/music-2.6");
  });
});

/** 依序回放的 fetch 桩:每次调用弹出一个预置响应。 */
const stubFetch = (responses: Array<{ status?: number; json?: unknown }>): ReturnType<typeof vi.fn> => {
  const fn = vi.fn(async () => {
    const next = responses.shift() ?? { status: 500, json: {} };
    return {
      ok: (next.status ?? 200) < 400,
      status: next.status ?? 200,
      json: async () => next.json ?? {},
      arrayBuffer: async () => new ArrayBuffer(4),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
};

const OPTS = { mediaBase: "https://api.atlascloud.ai/api/v1/model", apiKey: "k", timeoutMs: 5_000, pollMs: 1 };

describe("generateMedia(提交-轮询)", () => {
  it("提交拿 id → 轮询到 completed → 返回产物 URL(兼容 data 包一层的形态)", async () => {
    const fn = stubFetch([
      { json: { code: 200, data: { id: "pred-1" } } },
      { json: { data: { status: "processing", outputs: [] } } },
      { json: { data: { status: "completed", outputs: ["https://cdn.x/img.jpg"] } } },
    ]);
    const url = await generateMedia("generateImage", { model: "m", prompt: "p" }, OPTS);
    expect(url).toBe("https://cdn.x/img.jpg");
    // 轮询走 prediction 路径
    expect(String(fn.mock.calls[1][0])).toContain("/prediction/pred-1");
  });
  it("平铺形态(文档输出 schema)同样能读;succeeded 也算完成", async () => {
    stubFetch([
      { json: { code: 200, data: { id: "pred-2" } } },
      { json: { status: "succeeded", outputs: ["https://cdn.x/a.mp3"] } },
    ]);
    await expect(generateMedia("generateAudio", { model: "m", prompt: "p" }, OPTS)).resolves.toBe("https://cdn.x/a.mp3");
  });
  it("prediction 404 时切换 result 路径继续轮询(文档两种写法都覆盖)", async () => {
    const fn = stubFetch([
      { json: { code: 200, data: { id: "pred-3" } } },
      { status: 404 },
      { json: { data: { status: "completed", outputs: ["https://cdn.x/b.jpg"] } } },
    ]);
    await expect(generateMedia("generateImage", { model: "m", prompt: "p" }, OPTS)).resolves.toBe("https://cdn.x/b.jpg");
    expect(String(fn.mock.calls[2][0])).toContain("/result/pred-3");
  });
  it("任务 failed / 提交无 id 都抛错(调用方 fail-open)", async () => {
    stubFetch([
      { json: { code: 200, data: { id: "pred-4" } } },
      { json: { data: { status: "failed" } } },
    ]);
    await expect(generateMedia("generateImage", { model: "m", prompt: "p" }, OPTS)).rejects.toThrow(/failed/);
    stubFetch([{ json: { code: 401, message: "bad key" } }]);
    await expect(generateMedia("generateImage", { model: "m", prompt: "p" }, OPTS)).rejects.toThrow(/no prediction id/);
  });
});
