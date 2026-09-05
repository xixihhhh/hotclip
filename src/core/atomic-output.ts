import { mkdtemp, rename, rm, stat } from "fs/promises";
import { basename, dirname, join } from "path";

/** Render beside the destination; publish only after the producer has closed successfully. */
export async function withAtomicOutput<T>(
  outputPath: string,
  produce: (temporaryPath: string) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  signal?.throwIfAborted();
  const workspace = await mkdtemp(join(dirname(outputPath), ".hotclip-write-"));
  const temporaryPath = join(workspace, basename(outputPath));
  try {
    const result = await produce(temporaryPath);
    signal?.throwIfAborted();
    const info = await stat(temporaryPath);
    if (!info.isFile() || info.size === 0) throw new Error("export output is empty");
    await rename(temporaryPath, outputPath);
    return result;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
