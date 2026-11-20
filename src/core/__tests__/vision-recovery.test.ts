import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeVisionSheet, collectVisionSignal } from "../highlight/vision";
import { parseActionCells } from "../highlight/vision-recovery";

const local = { baseUrl: "http://127.0.0.1:8090/v1", apiKey: "", model: "vision" };
const remote = { ...local, baseUrl: "https://vision.example/v1" };
const times = [1, 3, 5];
const known = JSON.stringify({ cells: [{ i: 1, energy: 8, note: "goal", visibleText: ["1-0"] }] });
const actions = JSON.stringify({ cells: [
  { change: "none", note: "sitting" },
  { change: "strong_reaction", note: "arms raised", visibleText: ["neighbour's score"] },
  { change: "strong_reaction", note: "arms still raised" },
] });

function completion(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
}
afterEach(() => vi.unstubAllGlobals());

describe("local vision sheet recovery", () => {
  it.each([local, remote])("keeps a valid first reply and its OCR on $baseUrl", async (llm) => {
    const fetch = vi.fn().mockResolvedValue(completion(known));
    vi.stubGlobal("fetch", fetch);
    const result = await analyzeVisionSheet(llm, times, "image", new AbortController().signal);
    expect(result).toEqual({ cells: JSON.parse(known).cells, recovered: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).not.toHaveProperty("response_format");
  });

  it.each([
    [local, ["2-1", "2-1", "2-1"], "重复标题，无动作", [3, 3, 3]],
    [local, ["2-1", "3-1", "3-2"], "重复标题，无动作", [8, 8, 8]],
    [local, ["2-1", "2-1", "2-1"], "双手举起庆祝", [8, 8, 8]],
    [remote, ["2-1", "2-1", "2-1"], "重复标题，无动作", [8, 8, 8]],
  ] as const)("keeps text while checking contradictory static-title scores", async (llm, labels, note, expected) => {
    const cells = labels.map((label, index) => ({ i: index + 1, energy: 8, note, visibleText: [label] }));
    const fetch = vi.fn().mockResolvedValue(completion(JSON.stringify({ cells })));
    vi.stubGlobal("fetch", fetch);
    const result = await analyzeVisionSheet(llm, times, "image", new AbortController().signal);
    expect(result.cells?.map((c) => c.energy)).toEqual(expected);
    expect(result.cells?.map((c) => c.visibleText?.[0])).toEqual(labels);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["", '{"cells":[null,{"i":2,"energy":null}]}', "bad JSON"])("recovers unusable content %j with one bounded local request", async (content) => {
    const fetch = vi.fn().mockResolvedValueOnce(completion(content)).mockResolvedValueOnce(completion(actions));
    vi.stubGlobal("fetch", fetch);
    const result = await analyzeVisionSheet(local, times, "image", new AbortController().signal);
    expect(result).toEqual({ recovered: true, cells: [
      { i: 1, energy: 1, note: "sitting" }, { i: 2, energy: 8, note: "arms raised" },
      { i: 3, energy: 6, note: "arms still raised" },
    ] });
    const format = JSON.parse(fetch.mock.calls[1][1].body).response_format;
    expect(format.json_schema.schema.properties.cells).toMatchObject({ minItems: 3, maxItems: 3 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never sends a second analysis request to a remote model for malformed content", async () => {
    const fetch = vi.fn().mockResolvedValue(completion("bad"));
    vi.stubGlobal("fetch", fetch);
    expect(await analyzeVisionSheet(remote, times, "image", new AbortController().signal)).toEqual({ cells: null, recovered: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps authorization errors and cancellation out of format recovery", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    await expect(analyzeVisionSheet(local, times, "image", new AbortController().signal)).rejects.toThrow("401");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(analyzeVisionSheet(local, times, "image", controller.signal)).rejects.toThrow("cancelled");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects partial or reordered-by-ID fallback formats instead of assigning guessed timestamps", () => {
    expect(parseActionCells(actions, 9)).toBeNull();
    expect(parseActionCells(known, 1)).toBeNull();
    expect(parseActionCells('{"cells":[{"change":"other","note":"?"}]}', 1)).toBeNull();
  });

  it("keeps scanning when the local server rejects response_format", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(completion("broken")).mockResolvedValueOnce(new Response("unsupported", { status: 400 }));
    vi.stubGlobal("fetch", fetch);
    const outcome = await collectVisionSignal({ videoPath: "clip", durationSec: 40, config: local, composeSheet: async () => "image" });
    expect(outcome).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
