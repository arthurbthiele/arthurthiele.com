const MULTIPLIER_BY_SUFFIX: Record<string, number> = {
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000
};

const TYPED_NUMBER_PATTERN = /^(-?)(\d+(?:\.\d*)?|\.\d+)([kmb]?)$/;

/** Reads "80k", "1.5m", "-20,000", "A$300k" or "−4.5k" (typographic minus) as numbers; anything else is undefined. */
export function findTypedNumber(text: string) {
  const normalisedText = text
    .trim()
    .toLowerCase()
    .replace(/−/g, "-")
    .replace(/[\s,]/g, "")
    .replace(/^(-?)(?:[a-z]{0,3}\$)/, "$1");
  const match = TYPED_NUMBER_PATTERN.exec(normalisedText);
  if (match == null) return undefined;
  const [, sign = "", digits = "", suffix = ""] = match;
  const magnitude = Number(digits) * (MULTIPLIER_BY_SUFFIX[suffix] ?? 1);
  return sign === "-" ? -magnitude : magnitude;
}
