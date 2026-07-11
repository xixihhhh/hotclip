/**
 * 热词词表的本地持久化:userData/glossary.json。桌面端 IPC、MCP Server、
 * 录播监听共用同一份词表——一次纠错,处处生效。读失败/文件损坏一律
 * 返回空表(fail-open,绝不拖垮转写)。
 */
import { join } from "path";
import { mkdir, readFile, writeFile } from "fs/promises";
import type { GlossaryEntry } from "../shared/api-types";
import { sanitizeGlossary } from "../shared/glossary";

export function glossaryPath(userDataDir: string): string {
  return join(userDataDir, "glossary.json");
}

/** 读词表;文件不存在/损坏返回 []。 */
export async function loadGlossary(userDataDir: string): Promise<GlossaryEntry[]> {
  try {
    const raw = await readFile(glossaryPath(userDataDir), "utf8");
    return sanitizeGlossary(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** 整表写回(先清洗;目录不存在则建)。 */
export async function saveGlossary(userDataDir: string, entries: GlossaryEntry[]): Promise<GlossaryEntry[]> {
  const clean = sanitizeGlossary(entries);
  await mkdir(userDataDir, { recursive: true });
  await writeFile(glossaryPath(userDataDir), JSON.stringify(clean, null, 2), "utf8");
  return clean;
}
