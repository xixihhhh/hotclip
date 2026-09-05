/** Normalize for matching only; original spelling is never rewritten. */
export function matchingCharacters(text: string): string[] {
  return Array.from(text.normalize("NFKC").toLowerCase().normalize("NFC")).filter((ch) => /[\p{L}\p{M}\p{N}]/u.test(ch));
}

export function paraformerSupportsText(text: string): boolean {
  const chars = matchingCharacters(text);
  return chars.length > 0 && chars.every((ch) => /[\p{Script=Han}a-z0-9]/u.test(ch));
}
