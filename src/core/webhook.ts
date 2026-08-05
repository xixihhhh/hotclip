/**
 * 录播 webhook 端点:兼容录播姬(BililiveRecorder)与 blrec 的回调协议,
 * 下播/文件写完即自动出片——把「录制」这件事外包给已经很成熟的社区工具,
 * HotClip 只负责它擅长的切片。比轮询文件夹更实时,也不用猜文件写没写完
 * (录播工具自己知道,它发的就是「写完了」)。
 *
 * 两家协议都吃:
 *  - 录播姬 Webhook v2:{ EventType: "FileClosed", EventData: { RelativePath, ... } }
 *    给的是相对路径,要拼上用户配置的录播工作目录才是绝对路径;
 *  - blrec:{ type: "VideoPostprocessingCompletedEvent", data: { path, room_id } }
 *    给的是绝对路径。
 * 两家都可能对同一个文件发多个事件(写完 + 后处理完),重复由上层的
 * 已处理记录(与 watch 文件夹共用同一套 seen)兜住。
 *
 * webhook 是**外部输入**,按不可信处理:默认只绑 127.0.0.1、可设 token、
 * 限制 body 大小,并且解析出的路径必须落在允许的根目录之下——否则一个
 * 走偏的回调就能让 HotClip 去啃任意文件。解析是纯函数,可单测。
 */
import { createServer, type Server } from "http";
import { isAbsolute, join, normalize, resolve, sep } from "path";

/** 请求体大小上限(录播回调都是几百字节的 JSON,超了就是不对劲)。 */
export const WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

export interface RecorderEvent {
  /** 录播文件的绝对路径。 */
  path: string;
  source: "bililive-recorder" | "blrec";
  /** 房间号(有就带上,便于展示/命名)。 */
  room?: string;
  /** 直播间标题/主播名(有就带上)。 */
  title?: string;
}

/** 录播姬里代表「这个文件已经写完」的事件。 */
const BILILIVE_FILE_DONE = new Set(["fileclosed"]);
/**
 * blrec 里代表「文件可用了」的事件。两个都收:没开后处理时只有前者,
 * 开了后处理则后者才是最终可用的文件——重复触发由 seen 去重。
 */
const BLREC_FILE_DONE = new Set([
  "videofilecompletedevent",
  "videopostprocessingcompletedevent",
]);

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * 解析录播回调 body → 统一事件;不是「文件写完」类事件或字段不全时返回 null
 * (调用方照样回 200,免得录播工具反复重试)。纯函数。
 *
 * `workDir` 是录播姬的工作目录,用来把相对路径拼成绝对路径;没配就无法处理
 * 录播姬的回调(blrec 给绝对路径,不受影响)。
 */
export function parseRecorderWebhook(body: unknown, workDir?: string): RecorderEvent | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;

  // ---- 录播姬 Webhook v2 ----
  const eventType = str(b.EventType);
  if (eventType) {
    if (!BILILIVE_FILE_DONE.has(eventType.toLowerCase())) return null;
    const data = (typeof b.EventData === "object" && b.EventData !== null ? b.EventData : {}) as Record<string, unknown>;
    const rel = str(data.RelativePath);
    if (!rel) return null;
    // 录播姬给的是相对路径:没有工作目录就拼不出绝对路径,只能放弃
    const abs = isAbsolute(rel) ? rel : workDir ? join(workDir, rel) : "";
    if (!abs) return null;
    const room = data.RoomId !== undefined && data.RoomId !== null ? String(data.RoomId) : undefined;
    return {
      path: normalize(abs),
      source: "bililive-recorder",
      room,
      title: str(data.Title) || str(data.Name) || undefined,
    };
  }

  // ---- blrec ----
  const type = str(b.type);
  if (type) {
    if (!BLREC_FILE_DONE.has(type.toLowerCase())) return null;
    const data = (typeof b.data === "object" && b.data !== null ? b.data : {}) as Record<string, unknown>;
    const path = str(data.path);
    if (!path) return null;
    // blrec 给绝对路径;万一给了相对路径,同样按工作目录兜
    const abs = isAbsolute(path) ? path : workDir ? join(workDir, path) : "";
    if (!abs) return null;
    const room = data.room_id !== undefined && data.room_id !== null ? String(data.room_id) : undefined;
    return { path: normalize(abs), source: "blrec", room, title: str(data.title) || undefined };
  }

  return null;
}

/**
 * 路径必须落在某个允许的根目录之下(含根目录本身)。
 * webhook 来自外部,不做这道校验的话,一个走偏的回调就能指使 HotClip
 * 去处理机器上任意文件。roots 为空表示没配白名单——此时一律拒绝。纯函数。
 */
export function isPathAllowed(filePath: string, roots: string[]): boolean {
  if (!filePath || roots.length === 0) return false;
  const target = resolve(filePath);
  return roots.some((root) => {
    if (!root) return false;
    const base = resolve(root);
    return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
  });
}

/** 校验 token:没配 token 就不校验(仅监听回环时可接受)。纯函数。 */
export function isTokenValid(configured: string | undefined, provided: string | undefined): boolean {
  const want = (configured ?? "").trim();
  if (!want) return true;
  return (provided ?? "").trim() === want;
}

export interface WebhookServerOptions {
  port: number;
  /** 校验用 token:请求带 ?token= 或 X-HotClip-Token 头。 */
  token?: string;
  /** 录播姬工作目录(相对路径拼绝对路径用),同时作为允许的根目录之一。 */
  workDir?: string;
  /** 允许处理的根目录白名单;缺省时用 workDir。 */
  allowedRoots?: string[];
  /** 绑定地址;默认只绑回环——不要随手改成 0.0.0.0。 */
  host?: string;
  /** 收到一个可处理的录播文件(上层负责 stat/去重/排队)。 */
  onRecording: (e: RecorderEvent) => void;
  /** 诊断日志(拒绝原因等)。 */
  onLog?: (msg: string) => void;
}

export interface WebhookServerHandle {
  /** 实际监听端口(传 0 时由系统分配)。 */
  port: number;
  close: () => Promise<void>;
}

/** 读请求体,超过上限直接中止(不给内存炸弹机会)。 */
function readBody(
  req: NodeJS.ReadableStream & { destroy: () => void },
  maxBytes: number
): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

/**
 * 起一个本地 webhook 服务器。默认只绑 127.0.0.1:录播工具通常和 HotClip
 * 在同一台机器上,绑回环就够;要跨机器请自行做端口转发并务必配 token。
 *
 * 一律回 200(除了 token 不对回 401):录播工具见到非 2xx 会反复重试,
 * 而「这个事件我不处理」不是错误。
 */
export async function startWebhookServer(options: WebhookServerOptions): Promise<WebhookServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const roots = options.allowedRoots?.length ? options.allowedRoots : options.workDir ? [options.workDir] : [];
  const log = options.onLog ?? ((): void => {});

  const server: Server = createServer((req, res) => {
    const reply = (code: number, msg: string): void => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: code < 400, msg }));
    };
    if (req.method !== "POST") {
      reply(200, "hotclip webhook ready");
      return;
    }
    const url = new URL(req.url ?? "/", `http://${host}`);
    const header = req.headers["x-hotclip-token"];
    const provided = url.searchParams.get("token") ?? (Array.isArray(header) ? header[0] : header);
    if (!isTokenValid(options.token, provided ?? undefined)) {
      log("拒绝:token 不匹配");
      reply(401, "bad token");
      return;
    }
    void readBody(req, WEBHOOK_MAX_BODY_BYTES).then((raw) => {
      if (raw === null) {
        log("拒绝:请求体过大或读取失败");
        reply(200, "ignored");
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        log("忽略:请求体不是合法 JSON");
        reply(200, "ignored");
        return;
      }
      const event = parseRecorderWebhook(parsed, options.workDir);
      if (!event) {
        reply(200, "ignored"); // 不是「文件写完」事件:正常情况,不当错误
        return;
      }
      if (!isPathAllowed(event.path, roots)) {
        // 外部输入指向白名单之外:这是配置问题或恶意请求,必须让用户看见
        log(`拒绝:回调路径不在允许目录内 — ${event.path}`);
        reply(200, "path not allowed");
        return;
      }
      options.onRecording(event);
      reply(200, "accepted");
    });
  });

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(options.port, host, () => {
      server.removeListener("error", fail);
      ok();
    });
  });
  const addr = server.address();
  return {
    port: typeof addr === "object" && addr ? addr.port : options.port,
    close: () =>
      new Promise<void>((ok) => {
        server.close(() => ok());
        server.closeAllConnections?.();
      }),
  };
}
