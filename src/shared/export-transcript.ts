import type { RenderToggles } from "./api-types";

/** Sidecar captions and speech edits need the transcript even without burned captions. */
export function exportNeedsTranscript(options: Partial<RenderToggles>): boolean {
  return Boolean(
    (options.captionStyle && options.captionStyle !== "none") || options.subtitleFile ||
    options.jumpCut || options.cleanFillers || options.cutRetakes || options.translate || options.muteTerms?.length
  );
}
