/**
 * 导出位置(issue #3):用户改过就落他选的地方,没改过落系统「影片/HotClip」。
 * 这条链路错了成片就"消失"——用户根本不知道该去哪儿找,所以边界值全钉死。
 */
import { describe, expect, it } from "vitest";
import { join } from "path";
import { clipOutDir } from "../appenv";

describe("clipOutDir", () => {
  const videos = join("/Users", "duan", "Movies");

  it("没选过导出位置 → 系统影片目录下的 HotClip/<片名>", () => {
    expect(clipOutDir(undefined, videos, "直播回放")).toBe(join(videos, "HotClip", "直播回放"));
    expect(clipOutDir(null, videos, "直播回放")).toBe(join(videos, "HotClip", "直播回放"));
  });

  it("选过导出位置 → 落用户选的根目录下的 <片名>,不再拼 HotClip 一层", () => {
    const chosen = join("/Users", "duan", "Desktop", "我的成片");
    expect(clipOutDir(chosen, videos, "直播回放")).toBe(join(chosen, "直播回放"));
  });

  it("空串/纯空白视为没选过(旧偏好档里的脏值不能把成片扔到根目录)", () => {
    expect(clipOutDir("", videos, "片名")).toBe(join(videos, "HotClip", "片名"));
    expect(clipOutDir("   ", videos, "片名")).toBe(join(videos, "HotClip", "片名"));
  });

  it("选择路径首尾空格被裁掉(拖拽/粘贴路径常带)", () => {
    expect(clipOutDir("  /tmp/out  ", videos, "片名")).toBe(join("/tmp/out", "片名"));
  });

  it("片名照原样落一层子目录,不同素材互不覆盖", () => {
    const a = clipOutDir(undefined, videos, "第一场");
    const b = clipOutDir(undefined, videos, "第二场");
    expect(a).not.toBe(b);
    expect(a.endsWith(join("HotClip", "第一场"))).toBe(true);
  });
});
