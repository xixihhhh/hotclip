/**
 * HotClip Headless CLI —— 不开桌面端,终端或 Coding Agent 直接驱动本地
 * 切片管线(与桌面端/MCP/录播监听共用 core/pipeline,产物完全一致):
 *
 *   pnpm cli transcribe <视频>                     端侧逐字转写(带缓存)
 *   pnpm cli highlights <视频> [--max-clips N]      AI 找爆点(候选 JSON)
 *   pnpm cli clip <视频> [选项]                     全托管:转写→找爆点→出片+质检
 *
 * LLM 配置走环境变量(与 MCP Server 同一套):HOTCLIP_LLM_BASE_URL /
 * HOTCLIP_LLM_MODEL / HOTCLIP_LLM_API_KEY(本地 Ollama 免 key)。
 * 模型与转写缓存和桌面 App 共享——下载一次三边都能用。
 */
import { join, basename } from "path";
import { transcribeCached, detectForPipeline, autoClip, analyzeReferenceVideo } from "../core/pipeline";
import type { ReferenceProfile } from "../core/reference";
import { loadGlossary } from "../core/glossary-store";
import { userDataDir, modelsRoot, cacheDir, renderCacheDir, evidenceCacheDir, llmFromEnv } from "../core/appenv";
import { runDoctor } from "../core/doctor";
import { ensureModel } from "../core/models";
import { loadReviewMemory } from "../core/review-memory";
import { importPerformanceFile, loadPerformanceMemory, performanceReport } from "../core/performance-memory";

const USAGE = `HotClip CLI —— 本地 AI 切片,素材不出电脑

用法:
  pnpm cli transcribe <视频路径>
      端侧逐字转写(SenseVoice,带缓存;首次自动下载模型)

  pnpm cli highlights <视频路径> [--max-clips N] [--reference 对标视频] [--json]
      AI 通读全文找爆点,输出候选清单(评分/钩子/切点,先审后剪)
      --reference: 丢一条想对标的爆款切片,实测其节奏(时长/语速/镜头/钩子)
      生成画像,选段向对标节奏靠拢(偏好不是硬约束)

  pnpm cli clip <视频路径> [--max-clips N] [--reference 对标视频] [--no-vertical] [--no-captions] [--auto-enhance] [--denoise|--smart-denoise] [--out 目录] [--json]
      全托管一条龙:转写 → 找爆点 → 出片(竖屏/字幕/跳剪/响度默认全开)
      + 出片质检(黑屏/长静音/响度/时长/切点/平台违禁词复核),报告进 clips.json
      + 可自愈告警自动修复(首尾静音黑屏裁边/响度重归一,修复记录进 qa.repair)
      --auto-enhance: 本地测量保留画面,仅在明显偏暗/灰/过饱和时克制校正(默认关闭)
      --denoise: 基础固定滤镜降噪;--smart-denoise: 48kHz 本地模型增强人声,失败回退基础档

  pnpm cli doctor [--download]
      环境自检:ffmpeg/模型安装状态/LLM 端点/磁盘/缓存,给出修复建议
      --download: 把默认管线要用的模型现在预下载好(断点续传,断网重跑接着下)

  pnpm cli feedback <平台导出的 CSV 或 JSON>
      导入真实播放/点赞/评论/分享/收藏数据,本地学习高低表现模式
      支持中英文字段名与 1.2万/7.8k 等数字格式;同平台同视频重复导入会更新

  pnpm cli feedback-report [--json]
      查看 HotClip 已学到的高/低表现样例;之后桌面/CLI/MCP/监听找爆点都会使用

环境变量(highlights / clip 需要):
  HOTCLIP_LLM_BASE_URL   OpenAI 兼容端点(本地 Ollama: http://localhost:11434/v1)
  HOTCLIP_LLM_MODEL      模型名(如 qwen3:8b)
  HOTCLIP_LLM_API_KEY    云端接口的 key(本地 Ollama 可省)`;

/** 极简参数解析:布尔开关 + 带值选项,首个非选项参数是视频路径。 */
export interface CliArgs {
  command: string;
  videoPath: string;
  maxClips?: number;
  vertical: boolean;
  captions: boolean;
  autoEnhance: boolean;
  denoiseMode?: "basic" | "smart";
  outDir?: string;
  /** 对标爆款视频路径(参考画像驱动选段)。 */
  referencePath?: string;
  json: boolean;
  /** doctor 专用:把缺失的默认管线模型现在预下载好。 */
  download: boolean;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help") {
    throw new Error(USAGE);
  }
  const args: CliArgs = { command, videoPath: "", vertical: true, captions: true, autoEnhance: false, json: false, download: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--no-vertical") args.vertical = false;
    else if (a === "--no-captions") args.captions = false;
    else if (a === "--auto-enhance") args.autoEnhance = true;
    else if (a === "--denoise") args.denoiseMode = "basic";
    else if (a === "--smart-denoise") args.denoiseMode = "smart";
    else if (a === "--json") args.json = true;
    else if (a === "--download") args.download = true;
    else if (a === "--max-clips") {
      const v = Number(rest[++i]);
      if (!Number.isFinite(v)) throw new Error("--max-clips 需要一个数字");
      args.maxClips = Math.max(1, Math.min(12, Math.round(v)));
    } else if (a === "--out") {
      const v = rest[++i];
      if (!v) throw new Error("--out 需要一个目录路径");
      args.outDir = v;
    } else if (a === "--reference") {
      const v = rest[++i];
      if (!v) throw new Error("--reference 需要一个对标视频路径");
      args.referencePath = v;
    } else if (a.startsWith("--")) {
      throw new Error(`未知选项: ${a}\n\n${USAGE}`);
    } else if (!args.videoPath) {
      args.videoPath = a;
    }
  }
  // doctor/feedback-report 不吃路径;feedback 的位置参数是指标文件路径
  if (!args.videoPath && !["doctor", "feedback-report"].includes(args.command)) throw new Error(`缺少视频路径或数据文件路径\n\n${USAGE}`);
  return args;
}

function fmtClock(sec: number): string {
  const m = Math.floor(sec / 60);
  return `${String(m).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.command === "doctor") {
    // LLM 未配置不是错误(transcribe 用不到),按"未配置"呈现
    let llm = null;
    try {
      llm = llmFromEnv();
    } catch {
      // 保持 null
    }
    const report = await runDoctor({ modelsRoot: modelsRoot(), cacheDir: cacheDir(), renderCacheDir: renderCacheDir(), evidenceCacheDir: evidenceCacheDir(), llm });
    const icon = { ok: "✅", warn: "⚠️", fail: "❌" } as const;
    for (const c of report.checks) {
      process.stdout.write(`${icon[c.status]} ${c.name}:${c.detail}\n`);
      if (c.fix) process.stdout.write(`   ↳ ${c.fix}\n`);
    }
    if (args.download && report.missingCoreModels.length > 0) {
      const mb = (n: number): number => Math.round(n / (1024 * 1024));
      for (const asset of report.missingCoreModels) {
        await ensureModel(modelsRoot(), asset, (p) => {
          const pct = Math.min(100, Math.round((p.downloadedBytes / p.totalBytes) * 100));
          const verb = p.phase === "extract" ? "解压" : "下载";
          process.stderr.write(`\r${verb} ${asset.id}:${pct}%(${mb(p.downloadedBytes)}/${mb(p.totalBytes)}MB)   `);
        });
        process.stderr.write(`\r✅ ${asset.id} 已就绪${" ".repeat(24)}\n`);
      }
      process.stdout.write("默认管线模型全部就绪。\n");
    } else if (report.missingCoreModels.length > 0) {
      process.stdout.write(`有 ${report.missingCoreModels.length} 个默认管线模型未安装,可加 --download 现在下好。\n`);
    }
    if (report.checks.some((c) => c.status === "fail")) process.exitCode = 1;
    return;
  }

  if (args.command === "feedback") {
    const result = await importPerformanceFile(userDataDir(), args.videoPath);
    process.stdout.write(`已导入 ${result.imported} 条发布表现,跳过 ${result.skipped} 条无效记录;本地共学习 ${result.total} 条。\n`);
    process.stdout.write(`${performanceReport(result.entries)}\n`);
    return;
  }

  if (args.command === "feedback-report") {
    const entries = await loadPerformanceMemory(userDataDir());
    process.stdout.write(args.json ? `${JSON.stringify(entries, null, 2)}\n` : `${performanceReport(entries)}\n`);
    return;
  }

  const glossary = await loadGlossary(userDataDir());

  // 参考画像:用户显式给的输入,分析失败要说清并按无参考继续(不静默丢)
  const loadReference = async (): Promise<ReferenceProfile | undefined> => {
    if (!args.referencePath) return undefined;
    process.stderr.write("分析对标视频节奏…\n");
    try {
      const p = await analyzeReferenceVideo(args.referencePath, {
        modelsRoot: modelsRoot(),
        cacheDir: cacheDir(),
        evidenceCacheDir: evidenceCacheDir(),
        glossary,
      });
      const cuts = p.cutsPerMin !== null ? `·镜头 ${p.cutsPerMin} 切/分` : "";
      const unit = p.zh ? "字" : "词";
      process.stderr.write(
        `参考画像:时长 ${Math.round(p.durationSec)}s·语速 ${p.speechRate}${unit}/秒·句长 ${p.avgSentenceLen}${unit}${cuts}·钩子「${p.hookLine.slice(0, 20)}」\n`
      );
      return p;
    } catch (e) {
      process.stderr.write(`⚠ 对标视频分析失败,按无参考继续:${e instanceof Error ? e.message : String(e)}\n`);
      return undefined;
    }
  };

  if (args.command === "transcribe") {
    const t = await transcribeCached(args.videoPath, modelsRoot(), cacheDir(), glossary);
    for (const s of t.segments) process.stdout.write(`[${fmtClock(s.startSec)}] ${s.text}\n`);
    process.stderr.write(`语言:${t.language} 时长:${fmtClock(t.durationSec)} 共 ${t.segments.length} 句\n`);
    return;
  }

  if (args.command === "highlights") {
    const llm = llmFromEnv();
    const reference = await loadReference();
    process.stderr.write("转写中(带缓存)…\n");
    const transcript = await transcribeCached(args.videoPath, modelsRoot(), cacheDir(), glossary);
    process.stderr.write("AI 找爆点中…\n");
    const candidates = await detectForPipeline(args.videoPath, transcript, {
      modelsRoot: modelsRoot(),
      evidenceCacheDir: evidenceCacheDir(),
      llm,
      maxClips: args.maxClips,
      reference,
      // 桌面审阅台积累的本机偏好,CLI 检测同享(只读)
      reviewMemory: await loadReviewMemory(userDataDir()),
      performanceMemory: await loadPerformanceMemory(userDataDir()),
    });
    if (candidates.length === 0) {
      process.stderr.write("没有找到值得切的爆点候选。\n");
      return;
    }
    const rows = candidates.map((c) => ({
      id: c.id,
      start: fmtClock(c.startSec),
      end: fmtClock(c.endSec),
      startSec: c.startSec,
      endSec: c.endSec,
      title: c.title,
      hook: c.hook,
      score: c.score,
      reason: c.reason,
      recommended: c.recommended,
      reviewNote: c.reviewNote || undefined,
      visualEvidence: c.visualEvidence,
    }));
    if (args.json) {
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    } else {
      for (const r of rows) {
        const mark = r.recommended ? "✅" : "⚠️ 不建议发布";
        process.stdout.write(`#${r.id} [${r.start}-${r.end}] 评分 ${r.score} ${mark}\n  ${r.title}\n  钩子:${r.hook}\n`);
      }
    }
    return;
  }

  if (args.command === "clip") {
    const llm = llmFromEnv();
    const reference = await loadReference();
    const outcome = await autoClip(args.videoPath, {
      modelsRoot: modelsRoot(),
      cacheDir: cacheDir(),
      renderCacheDir: renderCacheDir(),
      evidenceCacheDir: evidenceCacheDir(),
      llm,
      maxClips: args.maxClips,
      vertical: args.vertical,
      captions: args.captions,
      autoEnhance: args.autoEnhance,
      denoiseMode: args.denoiseMode,
      outDir: args.outDir,
      reference,
      reviewMemory: await loadReviewMemory(userDataDir()),
      performanceMemory: await loadPerformanceMemory(userDataDir()),
      fontsDir: join(__dirname, "..", "..", "resources", "fonts"),
      glossary,
      onStage: (stage) => {
        const label = { transcribing: "转写中(带缓存)…", detecting: "AI 找爆点中…", exporting: "出片中…" }[stage];
        process.stderr.write(`${label}\n`);
      },
    });
    if (outcome.exported.length === 0) {
      process.stderr.write("AI 复评后没有建议发布的切片(候选都被判定为弱钩子)。可用 highlights 命令查看全部候选与复评意见。\n");
      return;
    }
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            outDir: outcome.outDir,
            clips: outcome.exported.map((r) => ({
              file: basename(r.path),
              path: r.path,
              durationSec: Math.round(r.durationSec * 1000) / 1000,
              colorConverted: Boolean(r.colorConverted),
              colorConversionSkipped: Boolean(r.colorConversionSkipped),
              colorInspectionFailed: Boolean(r.colorInspectionFailed),
              audioEnhancement: r.audioEnhancement ?? null,
              qa: r.qa ?? null,
            })),
          },
          null,
          2
        )}\n`
      );
      return;
    }
    process.stdout.write(`已导出 ${outcome.exported.length} 条切片到 ${outcome.outDir}\n`);
    for (const r of outcome.exported) {
      const c = outcome.candidates.find((x) => x.id === r.id);
      const colorNote = r.colorConverted
        ? " · HDR→SDR"
        : r.colorConversionSkipped
          ? " · HDR 色彩路径不支持,未转换"
          : r.colorInspectionFailed
            ? " · 色彩信息检查失败"
            : "";
      const audioNote = r.audioEnhancement ? ` · 音频:${r.audioEnhancement}` : "";
      process.stdout.write(`- ${basename(r.path)} (${Math.round(r.durationSec)}s, 评分 ${c?.score ?? "?"}${colorNote}${audioNote}) ${c?.title ?? ""}\n`);
      if (r.qa && r.qa.status === "warn") {
        process.stdout.write(`  ⚠ 质检:${r.qa.issues.join(";")}\n`);
      }
      if (r.qa?.repair?.applied) {
        process.stdout.write(`  🔧 已自动修复:${r.qa.repair.actions.join("、")}\n`);
      }
    }
    const warned = outcome.exported.filter((r) => r.qa?.status === "warn").length;
    process.stdout.write(
      warned > 0
        ? `出片质检:${warned} 条有告警(详见 clips.json 的 qa 字段)\n`
        : "出片质检:全部通过(黑屏/长静音/响度/时长/切点/违禁词复核)\n"
    );
    process.stdout.write("附带 clips.json(标题/评分/时间码/回执/质检)与每条封面 JPG。\n");
    return;
  }

  throw new Error(`未知命令: ${args.command}\n\n${USAGE}`);
}

// 仅作为入口执行时才跑主流程(单测只 import parseCliArgs)
if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
