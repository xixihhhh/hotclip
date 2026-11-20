export interface EpisodeStructure { opening: number; body: number; ending: number }

export function episodeStructure(value: unknown): EpisodeStructure | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { opening, body, ending } = value as Partial<EpisodeStructure>;
  if (![opening, body, ending].every((s) => typeof s === "number" && Number.isFinite(s) && s >= 1 && s <= 180)) return undefined;
  return { opening: opening!, body: body!, ending: ending! };
}
