/** Reproducible, explicit local-ASR evaluation. No cloud engines are accepted. */
import { readFile } from "fs/promises";
import { dirname, resolve } from "path";
import { performance } from "perf_hooks";
import { matchingCharacters } from "../src/shared/speech-text";
import { QwenLocalEngine, qwenHealth } from "../src/core/transcribe/qwen-local";
import { SenseVoiceEngine } from "../src/core/transcribe/sensevoice";
import { ParaformerEngine } from "../src/core/transcribe/paraformer";
import { FireRedEngine } from "../src/core/transcribe/firered";

function distance(a: string[], b: string[]): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const row = [i + 1];
    for (let j = 0; j < b.length; j++) row.push(Math.min(row[j] + 1, previous[j + 1] + 1, previous[j] + Number(a[i] !== b[j])));
    previous = row;
  }
  return previous[b.length];
}

async function main(): Promise<void> {
  const manifest = process.argv[2];
  if (!manifest) throw new Error("Usage: pnpm quality:eval:asr <fixtures.json> [sensevoice,qwen3]");
  const cases = JSON.parse(await readFile(manifest, "utf8")) as Array<{ id: string; audio: string; text: string; boundaries?: { firstSec: number; lastSec: number } }>;
  if (!Array.isArray(cases) || !cases.length || cases.length > 50 || cases.some((c) => !c.audio || typeof c.text !== "string" || c.text.length > 4000)) throw new Error("Invalid fixture manifest");
  const modelsRoot = resolve(process.env.HOTCLIP_MODELS_DIR || "models");
  const url = process.env.HOTCLIP_QWEN_URL || "http://127.0.0.1:8766";
  const ids = (process.argv[3] || "sensevoice,qwen3").split(",");
  const results = [];
  for (const id of ids) {
    const engine = id === "qwen3" ? new QwenLocalEngine(url) : id === "sensevoice" ? new SenseVoiceEngine(modelsRoot) : id === "paraformer" ? new ParaformerEngine(modelsRoot) : id === "fireredasr" ? new FireRedEngine(modelsRoot) : null;
    if (!engine) throw new Error(`Unknown local engine ${id}`);
    const model = id === "qwen3" ? await qwenHealth(url).catch(() => null) : null;
    for (const fixture of cases) {
      const start = performance.now();
      try {
        const transcript = await engine.transcribe(resolve(dirname(manifest), fixture.audio));
        const words = transcript.segments.flatMap((segment) => segment.words);
        const text = transcript.segments.map((segment) => segment.text).join(" ");
        const expected = matchingCharacters(fixture.text);
        const actual = matchingCharacters(text);
        const elapsedSec = (performance.now() - start) / 1000;
        results.push({ engine: id, model, fixture: fixture.id, durationSec: transcript.durationSec, elapsedSec, realTimeFactor: elapsedSec / transcript.durationSec,
          characterErrorRate: expected.length ? distance(expected, actual) / expected.length : null,
          silenceHallucinatedChars: expected.length ? null : actual.length,
          wordErrorRate: !expected.length || /\p{Script=Han}/u.test(fixture.text) ? null : distance(fixture.text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [], text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []) / Math.max(1, fixture.text.match(/[\p{L}\p{M}\p{N}]+/gu)?.length ?? 0),
          estimatedWords: words.filter((w) => w.timingSource === "estimated").length,
          interpolatedWords: words.filter((w) => w.timingSource === "interpolated").length,
          boundaryErrorSec: fixture.boundaries && words.length ? { first: Math.abs(words[0].startSec - fixture.boundaries.firstSec), last: Math.abs(words[words.length - 1].endSec - fixture.boundaries.lastSec) } : null,
          hostRssMb: process.memoryUsage().rss / 1024 / 1024,
          timingNote: "hostRssMb excludes an external Qwen service; boundary error needs manually annotated fixtures. First call includes model preparation.",
        });
      } catch (error) { results.push({ engine: id, fixture: fixture.id, error: String(error), elapsedSec: (performance.now() - start) / 1000 }); }
    }
  }
  process.stdout.write(JSON.stringify({ results }, null, 2) + "\n");
  if (results.some((r) => "error" in r)) process.exitCode = 1;
}
main().catch((error) => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; });
