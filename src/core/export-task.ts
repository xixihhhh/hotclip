/** One desktop export owns cancellation from preparation through final delivery. */
export class ExportTaskRunner {
  private active: AbortController | null = null;

  cancel(): void {
    this.active?.abort(new Error("export:cancelled"));
  }

  async run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.active) throw new Error("export:busy");
    const controller = new AbortController();
    this.active = controller;
    try {
      const result = await work(controller.signal);
      controller.signal.throwIfAborted();
      return result;
    } catch (error) {
      controller.signal.throwIfAborted();
      throw error;
    } finally {
      this.active = null;
    }
  }
}

/** Optional content may fail; cancellation must never become a fallback. */
export async function optionalExportStep<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T | null> {
  signal.throwIfAborted();
  try {
    const result = await work();
    signal.throwIfAborted();
    return result;
  } catch {
    signal.throwIfAborted();
    return null;
  }
}
