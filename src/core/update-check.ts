/**
 * 新版本检查:启动时静默问一次 GitHub releases/latest,有新版就在页头
 * 提示并指向下载页——未签名应用接自动更新链路太重,「知道有新版」是
 * 分发闭环里最薄也最必要的一环。断网/限流/解析失败全部静默(fail-open),
 * 永不打扰。纯函数(版本比对/响应解析)可单测;fetch 注入。
 */

export const RELEASES_URL = "https://github.com/xixihhhh/hotclip/releases/latest";
const LATEST_API = "https://api.github.com/repos/xixihhhh/hotclip/releases/latest";

/** "v1.2.3" / "1.2.3" → [1,2,3];无法解析返回 null。 */
export function parseVersion(v: string): [number, number, number] | null {
  const m = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** latest 比 current 新时返回 true(任一无法解析返回 false,宁静默不误报)。 */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

export interface UpdateInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
  url: string;
}

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  json: () => Promise<unknown>;
}>;

/** 查一次最新版;任何失败返回 null(绝不打扰用户)。 */
export async function checkForUpdate(
  currentVersion: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<UpdateInfo | null> {
  try {
    const res = await fetchImpl(LATEST_API, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: unknown };
    const latest = typeof data.tag_name === "string" ? data.tag_name : "";
    if (!parseVersion(latest)) return null;
    return {
      current: currentVersion,
      latest: latest.replace(/^v/, ""),
      hasUpdate: isNewerVersion(latest, currentVersion),
      url: RELEASES_URL,
    };
  } catch {
    return null;
  }
}
