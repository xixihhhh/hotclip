import { describe, it, expect } from "vitest";
import { parseVersion, isNewerVersion, checkForUpdate, RELEASES_URL } from "../update-check";

describe("parseVersion / isNewerVersion", () => {
  it("解析 v 前缀与三段号;垃圾返回 null", () => {
    expect(parseVersion("v0.6.0")).toEqual([0, 6, 0]);
    expect(parseVersion("1.2.30")).toEqual([1, 2, 30]);
    expect(parseVersion("latest")).toBeNull();
  });

  it("逐段比较,任一无法解析宁静默不误报", () => {
    expect(isNewerVersion("v0.7.0", "0.6.0")).toBe(true);
    expect(isNewerVersion("v0.6.1", "0.6.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("v0.6.0", "0.6.0")).toBe(false);
    expect(isNewerVersion("v0.5.9", "0.6.0")).toBe(false);
    expect(isNewerVersion("垃圾", "0.6.0")).toBe(false);
  });
});

describe("checkForUpdate", () => {
  const okFetch = (tag: string) => async () => ({ ok: true, json: async () => ({ tag_name: tag }) });

  it("有新版:hasUpdate=true 且指向 releases 页", async () => {
    const info = await checkForUpdate("0.6.0", okFetch("v0.7.0"));
    expect(info).toEqual({ current: "0.6.0", latest: "0.7.0", hasUpdate: true, url: RELEASES_URL });
  });

  it("已是最新:hasUpdate=false", async () => {
    expect((await checkForUpdate("0.6.0", okFetch("v0.6.0")))?.hasUpdate).toBe(false);
  });

  it("HTTP 失败/网络异常/tag 不可解析 → null(fail-open)", async () => {
    expect(await checkForUpdate("0.6.0", async () => ({ ok: false, json: async () => ({}) }))).toBeNull();
    expect(await checkForUpdate("0.6.0", async () => { throw new Error("offline"); })).toBeNull();
    expect(await checkForUpdate("0.6.0", okFetch("draft"))).toBeNull();
  });
});
