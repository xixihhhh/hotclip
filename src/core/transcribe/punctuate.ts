/**
 * Re-attach model-generated punctuation to timed words.
 *
 * Punctuation models (CT-Transformer) take plain text and return the same
 * text with punctuation inserted. We align the punctuated string back onto
 * the word stream and append each punctuation mark to the word it follows —
 * sentence segmentation then sees it exactly like engines that emit
 * punctuation natively. Alignment is fail-open: any mismatch returns the
 * original words untouched (better unpunctuated than corrupted).
 */
import type { TranscriptWord } from "./types";

const PUNCT_RE = /[^\p{L}\p{N}\s]/u;

export function applyPunctuation(words: TranscriptWord[], punctuated: string): TranscriptWord[] {
  if (words.length === 0) return words;
  const out = words.map((w) => ({ ...w }));
  let wi = 0;
  let ci = 0;
  for (const ch of punctuated) {
    if (/\s/.test(ch)) continue;
    const word = out[wi];
    if (!word) {
      // text after the last word — keep trailing punctuation, reject extra letters
      if (!PUNCT_RE.test(ch)) return words;
      out[out.length - 1].text += ch;
      continue;
    }
    if (ch.toLowerCase() === word.text[ci]?.toLowerCase()) {
      ci++;
      if (ci >= word.text.length) {
        wi++;
        ci = 0;
      }
    } else if (PUNCT_RE.test(ch)) {
      // between words → belongs to the previous word; inside one → to it
      const anchor = ci === 0 ? out[wi - 1] : out[wi];
      if (anchor) anchor.text += ch;
    } else {
      return words; // alignment broke — fail open
    }
  }
  return out;
}
