/** A small local VLM can identify a visible action even when it cannot produce the full sheet schema. */
export const ACTION_PROMPT =
  "看同一视频的按时间排序画格。逐格按顺序客观描述可见动作。change字段：none=静态、平静讲话、持物展示、单纯字幕/比分数字；" +
  "gesture=普通手势/轻微移动；strong_reaction=可直接看到明显爆发性动作，例如双手举过头顶庆祝或突然激烈动作。" +
  "首格没有足够变化证据时选none。静态文字绝不是动作。note只写动作，最多八个字，不猜测情绪，不抄录文字。";

export function actionResponseFormat(count: number) {
  const item = {
    type: "object", additionalProperties: false, required: ["change", "note"],
    properties: { change: { type: "string", enum: ["none", "gesture", "strong_reaction"] }, note: { type: "string" } },
  };
  return { type: "json_schema", json_schema: { name: "visual_actions", strict: true, schema: {
    type: "object", additionalProperties: false, required: ["cells"],
    properties: { cells: { type: "array", minItems: count, maxItems: count, items: item } },
  } } };
}

export function parseActionCells(content: string, count: number) {
  let value;
  try { value = JSON.parse(content); } catch { return null; }
  const cells: unknown = value?.cells;
  if (!Array.isArray(cells) || cells.length !== count) return null;
  const out: Array<{ i: number; energy: number; note: string }> = [];
  let previous: string | undefined;
  for (const cell of cells) {
    if (!cell || !["none", "gesture", "strong_reaction"].includes(cell.change) || typeof cell.note !== "string") return null;
    // A whole grid of high ratings has no local contrast. Only an observed
    // transition within a sheet can contribute a recovery peak.
    const onset = previous === "none" || previous === "gesture";
    const energy = cell.change === "strong_reaction" ? (onset ? 8 : 6) : cell.change === "gesture" ? 3 : 1;
    out.push({ i: out.length + 1, energy, note: cell.note.trim().slice(0, 40) });
    previous = cell.change;
  }
  return out;
}
