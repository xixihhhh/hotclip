import { parentPort, workerData } from "worker_threads";
import { SenseVoiceEngine } from "../core/transcribe/sensevoice";
import { ParaformerEngine } from "../core/transcribe/paraformer";
import { FireRedEngine } from "../core/transcribe/firered";
import { QwenLocalEngine } from "../core/transcribe/qwen-local";
import { ElevenLabsEngine } from "../core/transcribe/elevenlabs";
import { previewTranscriptAlignment } from "../core/transcript-alignment";

const abort = new AbortController();
parentPort?.on("message", (message) => { if (message === "cancel") abort.abort(); });
const job = workerData;
async function run(): Promise<unknown> {
  if (job.kind === "align") return previewTranscriptAlignment(job.filePath, job.transcript, job.request, job.modelsRoot, abort.signal);
  const engine = job.engineId === "qwen3" ? new QwenLocalEngine(job.options?.localServiceUrl)
    : job.engineId === "elevenlabs" ? new ElevenLabsEngine(job.apiKey ?? "")
    : job.engineId === "paraformer" ? new ParaformerEngine(job.modelsRoot)
    : job.engineId === "fireredasr" ? new FireRedEngine(job.modelsRoot)
    : new SenseVoiceEngine(job.modelsRoot);
  return engine.transcribe(job.filePath, {
    ...job.options, cacheDir: job.cacheDir, signal: abort.signal,
    onProgress: (progress) => parentPort?.postMessage({ progress }),
  });
}
run().then((result) => parentPort?.postMessage({ result }), (error) => parentPort?.postMessage({ error: abort.signal.aborted ? "speech:cancelled" : String(error?.message ?? error) }))
  .finally(() => parentPort?.close());
