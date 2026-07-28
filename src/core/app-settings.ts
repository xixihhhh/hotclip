/**
 * 本机应用设置(桌面 / CLI / MCP 共用一份):落 <userData>/settings.json。
 *
 * 目前只有「模型存放位置」一项——1GB 起步的模型放在哪儿,用户有权知道、
 * 也有权换到别的盘(issue #3 用户原话:大文件我都会比较关注)。
 * 读取是同步的:modelsRoot() 在各处被当普通取值用,异步化会污染一大片调用链。
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

export interface AppSettings {
  /** 模型存放根目录;缺省 = <userData>/models。 */
  modelsDir?: string;
}

export function settingsPath(userDataDir: string): string {
  return join(userDataDir, "settings.json");
}

/** 读设置;文件缺失或损坏一律回落出厂默认——设置读不出来绝不该挡住出片。 */
export function readAppSettings(userDataDir: string): AppSettings {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(userDataDir), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const dir = (parsed as AppSettings).modelsDir;
    return typeof dir === "string" && dir.trim() ? { modelsDir: dir.trim() } : {};
  } catch {
    return {};
  }
}

export function writeAppSettings(userDataDir: string, next: AppSettings): void {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(settingsPath(userDataDir), JSON.stringify(next, null, 2), "utf8");
}

/** 出厂模型目录——用户没改过时就是它。 */
export function defaultModelsRoot(userDataDir: string): string {
  return join(userDataDir, "models");
}

/** 模型根目录:用户设过用他的,否则出厂位置。 */
export function resolveModelsRoot(userDataDir: string): string {
  return readAppSettings(userDataDir).modelsDir ?? defaultModelsRoot(userDataDir);
}
