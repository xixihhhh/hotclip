import { describe, it, expect, afterEach } from "vitest";
import {
  parseRecorderWebhook,
  isPathAllowed,
  isTokenValid,
  startWebhookServer,
  WEBHOOK_MAX_BODY_BYTES,
  type RecorderEvent,
  type WebhookServerHandle,
} from "../webhook";

describe("parseRecorderWebhook — 录播姬 Webhook v2", () => {
  const fileClosed = {
    EventType: "FileClosed",
    EventTimestamp: "2026-08-05T10:00:00.000Z",
    EventId: "abc",
    EventData: {
      RelativePath: "23058/录播-23058-20260805.flv",
      FileSize: 1234567,
      RoomId: 23058,
      Name: "某主播",
      Title: "今天开黑",
    },
  };

  it("FileClosed:相对路径拼上工作目录成绝对路径", () => {
    const e = parseRecorderWebhook(fileClosed, "/rec")!;
    expect(e.source).toBe("bililive-recorder");
    expect(e.path).toBe("/rec/23058/录播-23058-20260805.flv");
    expect(e.room).toBe("23058");
    expect(e.title).toBe("今天开黑");
  });

  it("没配工作目录时录播姬的相对路径无法处理(不猜路径)", () => {
    expect(parseRecorderWebhook(fileClosed, undefined)).toBeNull();
  });

  it("非「文件写完」事件一律忽略(开播/分段开始都不该触发切片)", () => {
    for (const EventType of ["SessionStarted", "FileOpening", "SessionEnded", "StreamStarted"]) {
      expect(parseRecorderWebhook({ ...fileClosed, EventType }, "/rec")).toBeNull();
    }
  });

  it("缺 RelativePath 直接放弃", () => {
    expect(parseRecorderWebhook({ EventType: "FileClosed", EventData: {} }, "/rec")).toBeNull();
  });
});

describe("parseRecorderWebhook — blrec", () => {
  it("后处理完成事件:直接用绝对路径", () => {
    const e = parseRecorderWebhook(
      {
        id: "x",
        date: "2026-08-05T10:00:00+08:00",
        type: "VideoPostprocessingCompletedEvent",
        data: { room_id: 12345, path: "/data/blrec/直播回放.mp4" },
      },
      "/rec"
    )!;
    expect(e.source).toBe("blrec");
    expect(e.path).toBe("/data/blrec/直播回放.mp4");
    expect(e.room).toBe("12345");
  });

  it("文件写完事件也收(没开后处理时只有这个)", () => {
    const e = parseRecorderWebhook(
      { type: "VideoFileCompletedEvent", data: { room_id: 1, path: "/data/a.flv" } },
      undefined
    );
    expect(e?.path).toBe("/data/a.flv");
  });

  it("其他事件类型忽略", () => {
    for (const type of ["LiveBeganEvent", "RecordingStartedEvent", "SpaceNoEnoughEvent"]) {
      expect(parseRecorderWebhook({ type, data: { path: "/data/a.flv" } }, "/rec")).toBeNull();
    }
  });
});

describe("parseRecorderWebhook — 垃圾输入", () => {
  it("非对象/空/未知形状都返回 null 而不是抛异常", () => {
    for (const body of [null, undefined, "", 42, [], {}, { foo: "bar" }, { EventType: 123 }]) {
      expect(parseRecorderWebhook(body, "/rec")).toBeNull();
    }
  });
});

describe("isPathAllowed", () => {
  it("允许根目录内的文件", () => {
    expect(isPathAllowed("/rec/room/a.flv", ["/rec"])).toBe(true);
    expect(isPathAllowed("/rec", ["/rec"])).toBe(true);
  });

  it("挡住目录穿越与白名单之外的路径", () => {
    expect(isPathAllowed("/rec/../etc/passwd", ["/rec"])).toBe(false);
    expect(isPathAllowed("/etc/passwd", ["/rec"])).toBe(false);
    // 前缀相同但不是子目录(/record 不属于 /rec)
    expect(isPathAllowed("/record/a.flv", ["/rec"])).toBe(false);
  });

  it("没配白名单时一律拒绝(不给外部输入放行任意路径)", () => {
    expect(isPathAllowed("/rec/a.flv", [])).toBe(false);
  });

  it("多个根目录任意命中即可", () => {
    expect(isPathAllowed("/data/b.mp4", ["/rec", "/data"])).toBe(true);
  });
});

describe("isTokenValid", () => {
  it("没配 token 就不校验", () => {
    expect(isTokenValid(undefined, undefined)).toBe(true);
    expect(isTokenValid("", "whatever")).toBe(true);
  });

  it("配了就必须一致", () => {
    expect(isTokenValid("s3cret", "s3cret")).toBe(true);
    expect(isTokenValid("s3cret", "wrong")).toBe(false);
    expect(isTokenValid("s3cret", undefined)).toBe(false);
  });
});

describe("startWebhookServer", () => {
  let handle: WebhookServerHandle | null = null;

  afterEach(async () => {
    await handle?.close();
    handle = null;
  });

  /** 起一个只绑回环、端口随机的实例。 */
  async function serve(opts: Partial<Parameters<typeof startWebhookServer>[0]> = {}) {
    const got: RecorderEvent[] = [];
    const logs: string[] = [];
    handle = await startWebhookServer({
      port: 0,
      workDir: "/rec",
      onRecording: (e) => got.push(e),
      onLog: (m) => logs.push(m),
      ...opts,
    });
    return { got, logs, url: `http://127.0.0.1:${handle.port}/` };
  }

  const post = (url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

  it("收到录播姬 FileClosed → 回调拿到绝对路径", async () => {
    const { got, url } = await serve();
    const res = await post(url, {
      EventType: "FileClosed",
      EventData: { RelativePath: "r/a.flv", RoomId: 7 },
    });
    expect(res.status).toBe(200);
    expect(got).toHaveLength(1);
    expect(got[0].path).toBe("/rec/r/a.flv");
  });

  it("白名单之外的路径被挡下,并且记了日志", async () => {
    const { got, logs, url } = await serve();
    const res = await post(url, {
      type: "VideoFileCompletedEvent",
      data: { path: "/etc/passwd" },
    });
    // 依然回 200:录播工具见到非 2xx 会无限重试
    expect(res.status).toBe(200);
    expect(got).toHaveLength(0);
    expect(logs.some((l) => l.includes("不在允许目录"))).toBe(true);
  });

  it("token 不对回 401 且不触发", async () => {
    const { got, url } = await serve({ token: "s3cret" });
    const res = await post(url, { EventType: "FileClosed", EventData: { RelativePath: "a.flv" } });
    expect(res.status).toBe(401);
    expect(got).toHaveLength(0);

    const ok = await post(`${url}?token=s3cret`, {
      EventType: "FileClosed",
      EventData: { RelativePath: "a.flv" },
    });
    expect(ok.status).toBe(200);
    expect(got).toHaveLength(1);
  });

  it("token 也可以走请求头", async () => {
    const { got, url } = await serve({ token: "s3cret" });
    await post(url, { EventType: "FileClosed", EventData: { RelativePath: "a.flv" } }, { "x-hotclip-token": "s3cret" });
    expect(got).toHaveLength(1);
  });

  it("非「文件写完」事件与坏 JSON 都回 200 且不触发(不让录播工具无限重试)", async () => {
    const { got, url } = await serve();
    expect((await post(url, { EventType: "SessionStarted", EventData: {} })).status).toBe(200);
    expect((await post(url, "{ this is not json")).status).toBe(200);
    expect(got).toHaveLength(0);
  });

  it("超大请求体被拒,服务器不被撑爆", async () => {
    const { got, url } = await serve();
    const huge = "x".repeat(WEBHOOK_MAX_BODY_BYTES + 1024);
    await post(url, JSON.stringify({ EventType: "FileClosed", pad: huge })).catch(() => null);
    expect(got).toHaveLength(0);
    // 服务器还活着:后续正常请求照常处理
    const res = await post(url, { EventType: "FileClosed", EventData: { RelativePath: "a.flv" } });
    expect(res.status).toBe(200);
    expect(got).toHaveLength(1);
  });

  it("GET 探活返回就绪信息(方便用户验证端口通不通)", async () => {
    const { url } = await serve();
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ready");
  });
});
