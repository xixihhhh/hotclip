import { Worker } from "worker_threads";
import { join } from "path";
import type { TranscribeProgressEvent } from "../shared/api-types";

/** Keep native inference off Electron's main thread; a hung native decode can
 * be terminated without losing already committed window checkpoints. */
export function runSpeechWorker<T>(job: Record<string, unknown>, signal: AbortSignal, progress?: (p: TranscribeProgressEvent) => void): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(__dirname, "speech-worker.js"), { workerData: job });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, result?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      void worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const cancel = (): void => {
      worker.postMessage("cancel");
      timer = setTimeout(() => finish(new Error("speech:cancelled")), 3000);
    };
    signal.addEventListener("abort", cancel, { once: true });
    worker.on("message", (message) => {
      if (message.progress) progress?.(message.progress);
      else if (signal.aborted) finish(new Error("speech:cancelled"));
      else if (message.error) finish(new Error(message.error));
      else if ("result" in message) finish(undefined, message.result);
    });
    worker.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    worker.on("exit", () => finish(new Error(signal.aborted ? "speech:cancelled" : "speech:worker-exited")));
  });
}
