import { describe, expect, it, vi } from "vitest";
import { ExportTaskRunner, optionalExportStep } from "../export-task";
import { translateSegments } from "../translate";

describe("desktop export ownership", () => {
  it("rejects overlapping work without stealing cancellation and releases the slot after cleanup", async () => {
    const runner = new ExportTaskRunner();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => { release = resolve; });
    const first = runner.run(async (signal) => {
      started();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      await cleanup;
    });
    const rejected = expect(first).rejects.toThrow("export:cancelled");
    await ready;
    const other = vi.fn();
    await expect(runner.run(other)).rejects.toThrow("export:busy");
    expect(other).not.toHaveBeenCalled();
    runner.cancel();
    await expect(runner.run(other)).rejects.toThrow("export:busy");
    release();
    await rejected;
    await expect(runner.run(async () => "next export")).resolves.toBe("next export");
  });

  it("cancels real translation preparation without continuing to optional fallback", async () => {
    const runner = new ExportTaskRunner();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const nextStep = vi.fn();
    const job = runner.run(async (signal) => {
      await optionalExportStep(signal, () => translateSegments([
        { id: 1, text: "测试", startSec: 0, endSec: 1 },
      ], "en", { baseUrl: "http://127.0.0.1:1", model: "test", apiKey: "" }, async (_llm, _system, _user, inner) => {
        started();
        return new Promise((_resolve, reject) => inner!.addEventListener("abort", () => reject(inner!.reason), { once: true }));
      }, signal));
      nextStep();
    });
    const rejected = expect(job).rejects.toThrow("export:cancelled");
    await ready;
    runner.cancel();
    await rejected;
    expect(nextStep).not.toHaveBeenCalled();
  });

  it("keeps ordinary optional failures recoverable, but never launches work after cancellation", async () => {
    const controller = new AbortController();
    await expect(optionalExportStep(controller.signal, async () => { throw new Error("offline"); })).resolves.toBeNull();
    controller.abort(new Error("cancelled"));
    const work = vi.fn();
    await expect(optionalExportStep(controller.signal, work)).rejects.toThrow("cancelled");
    expect(work).not.toHaveBeenCalled();
  });
});
