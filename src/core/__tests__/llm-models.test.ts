import { describe, it, expect } from "vitest";
import { parseModelIds, MODEL_LIST_MAX } from "../llm-models";

describe("parseModelIds", () => {
  it("认 OpenAI 标准形状 {data:[{id}]}", () => {
    expect(parseModelIds({ data: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }] })).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
  });

  it("也认裸数组和 {models:[]}(个别家不按标准来)", () => {
    expect(parseModelIds(["glm-4.7"])).toEqual(["glm-4.7"]);
    expect(parseModelIds({ models: [{ id: "qwen-plus" }] })).toEqual(["qwen-plus"]);
  });

  it("去重、去空白、按字母序排——下拉里不该出现重复项", () => {
    expect(parseModelIds({ data: [{ id: "b" }, { id: " b " }, { id: "a" }, { id: "" }] })).toEqual(["a", "b"]);
  });

  it("形状不对时返回空数组而不是抛异常(这只是个填表帮手)", () => {
    expect(parseModelIds(null)).toEqual([]);
    expect(parseModelIds({ error: "unauthorized" })).toEqual([]);
    expect(parseModelIds("nope")).toEqual([]);
  });

  it("聚合平台几百个模型时截断,不撑爆下拉", () => {
    const many = Array.from({ length: MODEL_LIST_MAX + 50 }, (_, i) => ({ id: `m${String(i).padStart(4, "0")}` }));
    expect(parseModelIds({ data: many })).toHaveLength(MODEL_LIST_MAX);
  });
});
