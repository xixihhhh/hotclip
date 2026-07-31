/**
 * Windows 非 ASCII 路径救援(issue #4):中文用户名下 sherpa 原生层打不开
 * 模型文件。真正的 8.3 转换只在 win32 上发生,这里钉死的是判定口径与
 * 「非 win32 / 纯 ASCII 一律原样直通」的边界——转换逻辑绝不能误伤正常路径。
 */
import { describe, expect, it } from "vitest";
import { hasNonAscii, psQuote, toAnsiSafeDir } from "../win-ansi-path";

describe("hasNonAscii", () => {
  it("中文/全角字符判为非 ASCII(正是 issue #4 的用户名场景)", () => {
    expect(hasNonAscii("C:\\Users\\楚心\\AppData\\Roaming\\hotclip\\models")).toBe(true);
    expect(hasNonAscii("C:\\Users\\ｕｓｅｒ\\models")).toBe(true);
  });

  it("纯 ASCII 路径(含空格与常见符号)判为安全", () => {
    expect(hasNonAscii("C:\\Program Files\\hotclip\\models")).toBe(false);
    expect(hasNonAscii("/Users/dev/Library/Application Support/hotclip")).toBe(false);
    expect(hasNonAscii("E:\\AI-tool\\hotclip_models (v2)")).toBe(false);
  });
});

describe("psQuote", () => {
  it("单引号翻倍,整体裹进单引号字面量", () => {
    expect(psQuote("C:\\a b")).toBe("'C:\\a b'");
    expect(psQuote("C:\\it's here")).toBe("'C:\\it''s here'");
  });
});

describe("toAnsiSafeDir", () => {
  it("非 win32 平台原样返回,不动任何进程", async () => {
    // 本仓库测试跑在 macOS/Linux 上——含中文的路径也必须直通
    const dir = "/tmp/楚心/models";
    expect(await toAnsiSafeDir(dir)).toBe(dir);
  });

  it("纯 ASCII 路径任何平台都原样返回", async () => {
    const dir = "C:\\Users\\dev\\hotclip\\models";
    expect(await toAnsiSafeDir(dir)).toBe(dir);
  });
});
