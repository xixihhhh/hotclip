/**
 * Reproducible local-VLM comparison using HotClip's exact contact-sheet path.
 *
 * Example:
 *   HOTCLIP_VISION_MODELS=qwen3-vl:4b,qwen3.5:4b pnpm quality:eval:vision
 *
 * The three checked-in demo clips deliberately cover action/reaction,
 * talking-head, and product footage. No source video is uploaded unless the
 * configured OpenAI-compatible endpoint itself is remote.
 */
import { resolve } from "path";
import { composeContactSheetJpeg } from "../src/core/contact-sheet";
import {
  parseSheetVerdicts,
  planFrameTimes,
  sheetUserPrompt,
  visionChatComplete,
  visionSystemPrompt,
} from "../src/core/highlight/vision";
import { probeMedia } from "../src/core/probe";

const DEFAULT_VIDEOS = ["docs/media/clip-1.mp4", "docs/media/clip-2.mp4", "docs/media/clip-3.mp4"];

interface PreparedCase {
  video: string;
  times: number[];
  sheet: string;
}

async function prepare(video: string): Promise<PreparedCase> {
  const path = resolve(video);
  const media = await probeMedia(path);
  const times = planFrameTimes(media.durationSec, undefined, 9, 0.8);
  const sheet = await composeContactSheetJpeg(path, times);
  if (!sheet) throw new Error(`could not compose contact sheet for ${video}`);
  return { video, times, sheet };
}

async function main(): Promise<void> {
  const videos = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const fixtures = await Promise.all((videos.length > 0 ? videos : DEFAULT_VIDEOS).map(prepare));
  const baseUrl = process.env.HOTCLIP_VISION_BASE_URL || "http://localhost:11434/v1";
  const models = (process.env.HOTCLIP_VISION_MODELS || "qwen3.5:4b")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const apiKey = process.env.HOTCLIP_VISION_API_KEY || "ollama";
  const results = [];
  for (const model of models) {
    const cases = [];
    for (const fixture of fixtures) {
      const started = Date.now();
      try {
        const raw = await visionChatComplete(
          { baseUrl, apiKey, model },
          visionSystemPrompt(fixture.times.length),
          sheetUserPrompt(fixture.times),
          fixture.sheet,
          AbortSignal.timeout(60_000)
        );
        const cells = parseSheetVerdicts(raw, fixture.times.length);
        cases.push({
          video: fixture.video,
          structured: cells !== null,
          frames: cells?.length ?? 0,
          meanEnergy: cells && cells.length > 0
            ? Number((cells.reduce((sum, cell) => sum + cell.energy, 0) / cells.length).toFixed(3))
            : null,
          visibleTextItems: cells?.reduce((sum, cell) => sum + (cell.visibleText?.length ?? 0), 0) ?? 0,
          notes: cells?.map((cell) => cell.note) ?? [],
          latencyMs: Date.now() - started,
        });
      } catch (error) {
        cases.push({
          video: fixture.video,
          structured: false,
          frames: 0,
          meanEnergy: null,
          visibleTextItems: 0,
          notes: [],
          latencyMs: Date.now() - started,
          error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
        });
      }
    }
    results.push({
      model,
      structuredRate: Number((cases.filter((testCase) => testCase.structured).length / cases.length).toFixed(3)),
      totalLatencyMs: cases.reduce((sum, testCase) => sum + testCase.latencyMs, 0),
      cases,
    });
  }
  process.stdout.write(`${JSON.stringify({ baseUrl, fixtures: fixtures.length, results }, null, 2)}\n`);
  if (results.every((result) => result.structuredRate === 0)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`vision benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
